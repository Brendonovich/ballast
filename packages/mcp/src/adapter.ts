import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  ArtifactSummary,
  ConnectionSummary,
  DeployProjectResult,
  HealthStatus,
  ListProjectFilesResponse,
  ProjectCheckResult,
  ProjectDetail,
  ProjectDiagnostic,
  ProjectIssue,
  ProjectManifest,
  ProjectRequirement,
  ProjectSummary,
  ProjectUnitChange,
  SourceLocation,
  UnitSummary,
} from "@ballast/agent-protocol";

import type { AgentGateway } from "./client.ts";
import { ToolError, toolError } from "./errors.ts";

/** The service's non-applying check result, passed through to the agent. */
export type CheckResult = ProjectCheckResult;

/** Shared project-state vocabulary for ballast_status and ballast_apply. */
export type ProjectState =
  | "running"
  | "starting"
  | "stopped"
  | "waiting_for_user"
  | "previous_version_running_latest_failed"
  | "error";

export type ApplyState = ProjectState;
export type ApplyReason =
  | "consent"
  | "start"
  | "connections"
  | "scopes"
  | "invalid"
  | "reload";

export interface ApplyOutcome {
  readonly state: ApplyState;
  readonly reason?: ApplyReason | undefined;
  readonly message: string;
  readonly check?: CheckResult | undefined;
  readonly project?: ProjectSummary | undefined;
}

/**
 * The seam between the MCP tools and the agent service. All project work is
 * service-side now: CreateProject scaffolds, CheckProject is non-applying, and
 * RestartProject is only called for an already-started, already-approved
 * project.
 */
export interface ProjectAdapter {
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectSummary>, ToolError>;
  readonly resolveProject: (reference: string) => Effect.Effect<ProjectSummary, ToolError>;
  readonly getProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly createProject: (
    name: string,
    directory?: string,
    artifact?: boolean,
  ) => Effect.Effect<ProjectDetail, ToolError>;
  readonly checkProject: (projectId: string) => Effect.Effect<CheckResult, ToolError>;
  readonly listProjectFiles: (
    projectId: string,
  ) => Effect.Effect<ListProjectFilesResponse, ToolError>;
  readonly listArtifacts: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactSummary>, ToolError>;
  readonly restartProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly shareProject: (
    projectId: string,
    message?: string,
  ) => Effect.Effect<DeployProjectResult, ToolError>;
  readonly listConnections: () => Effect.Effect<ReadonlyArray<ConnectionSummary>, ToolError>;
  readonly health: () => Effect.Effect<HealthStatus, ToolError>;
  readonly queryEventHistory: AgentGateway["queryEventHistory"];
  readonly listEventHistorySubscriptions: AgentGateway["listEventHistorySubscriptions"];
  readonly logs: AgentGateway["logs"];
  readonly events: AgentGateway["events"];
}

const samePath = (left: string, right: string): boolean => {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
};

const toPosix = (path: string): string => path.split(sep).join("/");

/** Expand a user-supplied path the way a shell or CLI would. */
const normalizeReferencePath = (reference: string): string => {
  const trimmed = reference.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
};

const pathSegments = (path: string): ReadonlyArray<string> =>
  toPosix(resolve(path))
    .split("/")
    .filter((segment) => segment !== "");

const looksLikePath = (reference: string): boolean =>
  isAbsolute(reference) ||
  reference.startsWith(".") ||
  reference.includes("/") ||
  reference.includes("\\");

const projectLabel = (project: ProjectSummary): string =>
  project.id + ' ("' + project.name + '") at ' + project.root;

const ambiguousProject = (
  reference: string,
  matches: ReadonlyArray<ProjectSummary>,
): ProjectMatch => ({
  error:
    "Project '" +
    reference +
    "' is ambiguous: " +
    matches.map(projectLabel).join(", ") +
    ". Use the project id to choose one.",
});

export type ProjectMatch =
  | { readonly project: ProjectSummary }
  | { readonly error: string };

/**
 * Resolve a project reference. Agents commonly pass either the display name
 * or the project folder name, so both are supported in addition to the id and
 * the absolute root. Relative paths are resolved from the MCP working
 * directory, with a trailing-segment fallback when that directory differs.
 */
export const matchProjectReference = (
  projects: ReadonlyArray<ProjectSummary>,
  reference: string,
): ProjectMatch => {
  const trimmed = reference.trim();
  if (trimmed === "") {
    return { error: "A project id, name or path is required." };
  }

  const byId = projects.find((project) => project.id === trimmed);
  if (byId !== undefined) return { project: byId };

  const lowered = trimmed.toLowerCase();
  const byName = projects.filter((project) => project.name.toLowerCase() === lowered);
  if (byName.length === 1) {
    const project = byName[0];
    if (project !== undefined) return { project };
  }
  if (byName.length > 1) return ambiguousProject(trimmed, byName);

  let target: string;
  try {
    target = normalizeReferencePath(trimmed);
  } catch {
    target = trimmed;
  }

  const byPath = projects.filter((project) => samePath(project.root, target));
  if (byPath.length === 1) {
    const project = byPath[0];
    if (project !== undefined) return { project };
  }
  if (byPath.length > 1) return ambiguousProject(trimmed, byPath);

  const pathLike = looksLikePath(trimmed);
  const referenceSegments = toPosix(trimmed.replace(/\\/g, "/"))
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const targetSegments = pathSegments(target);
  const targetBase = targetSegments[targetSegments.length - 1]?.toLowerCase() ?? "";
  const byDirectory = projects.filter((project) => {
    const rootSegments = pathSegments(project.root);
    if (pathLike) {
      // An absolute path was already compared exactly above. A relative path
      // may be written from another checkout (for example
      // "ballast-projects/chat-scenes"), so match its trailing directories.
      if (isAbsolute(trimmed)) return false;
      if (
        referenceSegments.length === 0 ||
        referenceSegments.length > rootSegments.length
      ) {
        return false;
      }
      const offset = rootSegments.length - referenceSegments.length;
      return referenceSegments.every(
        (segment, index) =>
          rootSegments[offset + index]?.toLowerCase() === segment.toLowerCase(),
      );
    }
    return (rootSegments[rootSegments.length - 1] ?? "").toLowerCase() === targetBase;
  });
  if (byDirectory.length === 1) {
    const project = byDirectory[0];
    if (project !== undefined) return { project };
  }
  if (byDirectory.length > 1) return ambiguousProject(trimmed, byDirectory);

  return {
    error:
      "No Ballast project matches '" +
      trimmed +
      "'. Known projects: " +
      (projects.length === 0 ? "none" : projects.map(projectLabel).join(", ")) +
      ". Pass an id, a display name, a folder name or a project root.",
  };
};

/**
 * The planner normally emits project-relative sources. A service bug can emit
 * repo/cwd-relative paths such as "../../ballast-projects/chat/src/a.ts";
 * recover the project-relative suffix when possible and drop foreign frames
 * (for example the core timer implementation).
 */
export const normalizeSourceLocation = (
  projectRoot: string,
  source: SourceLocation | undefined,
): SourceLocation | undefined => {
  if (source === undefined) return undefined;
  const raw = source.file;
  if (raw === "") return undefined;
  let file = toPosix(raw);

  if (isAbsolute(raw)) {
    const rel = toPosix(relative(projectRoot, raw));
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    file = rel;
  } else if (file.startsWith("..")) {
    const projectName = basename(projectRoot);
    const segments = file.split("/");
    const projectIndex = segments.lastIndexOf(projectName);
    if (projectIndex >= 0 && projectIndex + 1 < segments.length) {
      file = segments.slice(projectIndex + 1).join("/");
    } else {
      const rel = toPosix(relative(projectRoot, resolve(projectRoot, raw)));
      if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
      file = rel;
    }
  }

  return file === raw ? source : { ...source, file };
};

const manifestSource = (
  manifest: ProjectManifest | undefined,
  unit: UnitSummary,
): SourceLocation | undefined => {
  if (manifest === undefined) return undefined;
  switch (unit.kind) {
    case "topic":
      return manifest.topics.find((candidate) => candidate.name === unit.name)?.source;
    case "timer":
      return manifest.timers.find((candidate) => candidate.name === unit.name)?.source;
    case "workflow":
      return manifest.workflows.find((candidate) => candidate.name === unit.name)?.source;
    case "run":
      return manifest.runs.find((candidate) => candidate.name === unit.name)?.source;
    case "database":
      return manifest.databases?.find((candidate) => candidate.name === unit.name)?.source;
    case "param":
      return undefined;
  }
};

const normalizeUnit = (
  root: string,
  unit: UnitSummary,
  manifest: ProjectManifest | undefined,
): UnitSummary => {
  const source = normalizeSourceLocation(
    root,
    unit.source ?? manifestSource(manifest, unit),
  );
  return { ...unit, ...(source === undefined ? {} : { source }) };
};

const issueKey = (issue: ProjectIssue): string =>
  [
    issue.id,
    issue.kind,
    issue.severity,
    issue.title,
    issue.detail ?? "",
    issue.source?.file ?? "",
    issue.source?.line ?? "",
    issue.source?.column ?? "",
  ].join("\u0000");

/** The service can record the same issue once per failing bundle. */
export const dedupeIssues = (
  issues: ReadonlyArray<ProjectIssue>,
): ReadonlyArray<ProjectIssue> => {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizeIssues = (
  root: string,
  issues: ProjectDetail["issues"],
): ProjectDetail["issues"] =>
  dedupeIssues(
    issues.map((issue) => {
      const source = normalizeSourceLocation(root, issue.source);
      return { ...issue, ...(source === undefined ? {} : { source }) };
    }),
  );

const normalizeDetail = (detail: ProjectDetail): ProjectDetail => {
  const issues = normalizeIssues(detail.summary.root, detail.issues);
  return {
    ...detail,
    issues,
    summary: { ...detail.summary, issues },
    units: detail.units.map((unit) =>
      normalizeUnit(detail.summary.root, unit, detail.manifest),
    ),
  };
};

const normalizeCheck = (check: CheckResult): CheckResult => {
  const issues = normalizeIssues(check.summary.root, check.summary.issues);
  return {
    ...check,
    summary: { ...check.summary, issues },
    diagnostics: check.diagnostics.map((diagnostic) => {
      const source = normalizeSourceLocation(check.summary.root, {
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
      });
      return source === undefined ? diagnostic : { ...diagnostic, file: source.file };
    }),
    units: check.units.map((unit) =>
      normalizeUnit(check.summary.root, unit, check.manifest ?? check.appliedManifest),
    ),
    changes: check.changes.map((change) => {
      const source = normalizeSourceLocation(check.summary.root, change.source);
      return { ...change, ...(source === undefined ? {} : { source }) };
    }),
  };
};

export const makeProjectAdapter = (gateway: AgentGateway): ProjectAdapter => {
  const resolveProject = (reference: string): Effect.Effect<ProjectSummary, ToolError> =>
    Effect.gen(function* () {
      const projects = yield* gateway.listProjects();
      const match = matchProjectReference(projects, reference);
      if ("error" in match) {
        return yield* Effect.fail(toolError(match.error));
      }
      return match.project;
    });

  const getProject = (projectId: string): Effect.Effect<ProjectDetail, ToolError> =>
    gateway.getProject(projectId).pipe(Effect.map(normalizeDetail));

  return {
    listProjects: gateway.listProjects,
    resolveProject,
    getProject,
    createProject: (name, directory, artifact) =>
      gateway.createProject(name, directory, artifact).pipe(Effect.map(normalizeDetail)),
    checkProject: (projectId) =>
      gateway.checkProject(projectId).pipe(Effect.map(normalizeCheck)),
    listProjectFiles: gateway.listProjectFiles,
    listArtifacts: gateway.listArtifacts,
    restartProject: (projectId) =>
      gateway.restartProject(projectId).pipe(Effect.map(normalizeDetail)),
    shareProject: gateway.shareProject,
    listConnections: gateway.listConnections,
    health: gateway.health,
    queryEventHistory: gateway.queryEventHistory,
    listEventHistorySubscriptions: gateway.listEventHistorySubscriptions,
    logs: gateway.logs,
    events: gateway.events,
  };
};

export type RequirementState = "bound" | "proposed" | "unbound" | "missing";

export interface RequirementView {
  readonly integration: string;
  readonly slot: string;
  readonly location: "local" | "cloud" | "either";
  readonly state: RequirementState;
  readonly instanceId?: string | undefined;
  readonly label?: string | undefined;
  readonly status?: string | undefined;
  readonly compatibleCount: number;
  readonly requiredScopes: ReadonlyArray<string>;
  readonly missingScopes: ReadonlyArray<string>;
}

/**
 * Resolve each declared slot to the instance the user sees: an explicit
 * binding, a proposed sole instance, an unbound slot, or a dangling binding.
 */
export const requirementViews = (
  requirements: ReadonlyArray<ProjectRequirement>,
  connections: ReadonlyArray<ConnectionSummary>,
  manifest?: ProjectManifest | undefined,
): ReadonlyArray<RequirementView> =>
  requirements.map((requirement) => {
    const compatible = connections.filter(
      (connection) => connection.integration === requirement.integration,
    );
    const requiredScopes = [
      ...new Set([
        ...(manifest?.topics ?? [])
          .filter(
            (topic) =>
              topic.integration === requirement.integration &&
              topic.slot === requirement.slot,
          )
          .flatMap((topic) => topic.scopes),
        ...(manifest?.requests ?? [])
          .filter(
            (request) =>
              request.integration === requirement.integration &&
              request.slot === requirement.slot,
          )
          .flatMap((request) => request.scopes),
      ]),
    ];
    const scopesFor = (
      instance: ConnectionSummary | undefined,
    ): { requiredScopes: ReadonlyArray<string>; missingScopes: ReadonlyArray<string> } => {
      const granted = new Set(instance?.scopes.granted ?? []);
      return {
        requiredScopes,
        missingScopes: requiredScopes.filter((scope) => !granted.has(scope)),
      };
    };
    if (requirement.boundInstanceId !== undefined) {
      const instance = connections.find(
        (connection) => connection.id === requirement.boundInstanceId,
      );
      return {
        integration: requirement.integration,
        slot: requirement.slot,
        location: requirement.location,
        state: instance === undefined ? "missing" : "bound",
        instanceId: requirement.boundInstanceId,
        ...(instance === undefined
          ? {}
          : { label: instance.label, status: instance.status }),
        compatibleCount: compatible.length,
        ...scopesFor(instance),
      };
    }
    if (requirement.proposedInstanceId !== undefined) {
      const instance = connections.find(
        (connection) => connection.id === requirement.proposedInstanceId,
      );
      return {
        integration: requirement.integration,
        slot: requirement.slot,
        location: requirement.location,
        state: "proposed",
        instanceId: requirement.proposedInstanceId,
        ...(instance === undefined
          ? {}
          : { label: instance.label, status: instance.status }),
        compatibleCount: compatible.length,
        ...scopesFor(instance),
      };
    }
    return {
      integration: requirement.integration,
      slot: requirement.slot,
      location: requirement.location,
      state: "unbound",
      compatibleCount: compatible.length,
      ...scopesFor(undefined),
    };
  });

export const requirementLine = (view: RequirementView): string => {
  const slot = view.integration + "/" + view.slot;
  const needs =
    view.missingScopes.length === 0 ? "" : " · needs " + view.missingScopes.join(", ");
  switch (view.state) {
    case "bound":
      return (
        slot +
        ' → bound to "' +
        (view.label ?? view.instanceId) +
        '" (' +
        view.status +
        ")" +
        needs
      );
    case "missing":
      return slot + ' → bound to "' + view.instanceId + '" (missing)' + needs;
    case "proposed":
      return (
        slot +
        ' → proposed: "' +
        (view.label ?? view.instanceId) +
        '" (confirm at Start)' +
        needs
      );
    case "unbound":
      return view.compatibleCount === 0
        ? slot +
            " → none: user must add a " +
            view.integration +
            " connection in the Ballast app" +
            needs
        : slot +
            " → unbound: " +
            view.compatibleCount +
            " compatible connection" +
            (view.compatibleCount === 1 ? "" : "s") +
            " available" +
            needs;
  }
};

const sourceText = (unit: UnitSummary): string =>
  unit.source === undefined ? "" : " @ " + unit.source.file + ":" + unit.source.line;

const unitDetail = (unit: UnitSummary, manifest: ProjectManifest | undefined): string => {
  if (manifest === undefined) return unit.status;
  switch (unit.kind) {
    case "topic": {
      const topic = manifest.topics.find((candidate) => candidate.name === unit.name);
      return topic === undefined
        ? unit.status
        : topic.integration + "/" + topic.slot + " " + topic.topic;
    }
    case "timer": {
      const timer = manifest.timers.find((candidate) => candidate.name === unit.name);
      return timer === undefined
        ? unit.status
        : "durable timer · " + timer.onStale + " · " + timer.maxAgeMs + "ms";
    }
    case "workflow": {
      const workflow = manifest.workflows.find((candidate) => candidate.name === unit.name);
      return workflow === undefined ? unit.status : "durable workflow";
    }
    case "param": {
      const param = manifest.params.find((candidate) => candidate.key === unit.name);
      return param === undefined
        ? unit.status
        : "param " +
            param.type +
            (param.default === undefined ? "" : " · default " + JSON.stringify(param.default));
    }
    case "run":
      return "run (non-durable)";
    case "database":
      return "local SQLite · .ballast/db/" + unit.name + ".sqlite";
  }
};

const changePrefix = (change: "added" | "removed" | "changed"): string =>
  change === "added" ? "+" : change === "removed" ? "-" : "~";

export interface DeclarationUnitView {
  readonly kind: "artifact" | "api" | "store";
  readonly name: string;
  readonly source?: SourceLocation | undefined;
  readonly detail: string;
  readonly status: string;
}

/**
 * Artifacts, the API group and counters are declaration units in the manifest
 * but not yet rows in UnitSummary. Surface them from the manifest so check and
 * status show their sources and artifact build state.
 */
export const declarationUnits = (
  manifest: ProjectManifest | undefined,
  artifacts: ReadonlyArray<ArtifactSummary>,
  projectRoot: string,
  running: boolean,
): ReadonlyArray<DeclarationUnitView> => {
  if (manifest === undefined) return [];
  const status = running ? "active" : "waiting";
  const artifactUnits: ReadonlyArray<DeclarationUnitView> = (manifest.artifacts ?? []).map(
    (artifact) => {
      const summary = artifacts.find((candidate) => candidate.name === artifact.name);
      const source = normalizeSourceLocation(projectRoot, artifact.source);
      return {
        kind: "artifact",
        name: artifact.name,
        ...(source === undefined ? {} : { source }),
        detail:
          (artifact.title === undefined ? "" : artifact.title + " · ") +
          artifact.entry +
          (summary?.error === undefined ? "" : " · " + summary.error),
        status: summary?.status ?? status,
      };
    },
  );
  const api = manifest.api;
  const apiUnits: ReadonlyArray<DeclarationUnitView> =
    api === undefined
      ? []
      : [
          {
            kind: "api",
            name: "api",
            ...(normalizeSourceLocation(projectRoot, api.source) === undefined
              ? {}
              : { source: normalizeSourceLocation(projectRoot, api.source) }),
            detail:
              api.procedures.length +
              " procedure" +
              (api.procedures.length === 1 ? "" : "s") +
              " (" +
              api.procedures
                .map((procedure) => procedure.name + (procedure.stream ? ":stream" : ""))
                .join(", ") +
              ")",
            status,
          },
        ];
  const storeUnits: ReadonlyArray<DeclarationUnitView> = (manifest.stores ?? []).map(
    (store) => {
      const source = normalizeSourceLocation(projectRoot, store.source);
      return {
        kind: "store",
        name: store.name,
        ...(source === undefined ? {} : { source }),
        detail:
          "counter" +
          (store.initial === undefined ? "" : " · initial " + store.initial),
        status,
      };
    },
  );
  return [...artifactUnits, ...apiUnits, ...storeUnits];
};

export interface CheckExtras {
  readonly artifacts: ReadonlyArray<ArtifactSummary>;
  readonly declarations: ReadonlyArray<DeclarationUnitView>;
  readonly artifactOnly: boolean;
  readonly requiresWorkerRestart: boolean;
  /** Set when the service predates artifact listing; artifacts are omitted. */
  readonly artifactNote?: string | undefined;
}

const changeSummary = (check: CheckResult, extras: CheckExtras | undefined): string => {
  if (check.changes.length === 0) {
    return extras !== undefined && extras.artifacts.length > 0
      ? "no manifest changes (artifact edits hot-reload; API/worker edits restart)"
      : "no unit changes";
  }
  if (check.changes.every((change) => change.kind === "artifact")) {
    return "artifact-only (hot reload; worker stays)";
  }
  if (check.changes.some((change) => change.kind !== "artifact")) {
    return "restarts worker";
  }
  return "no unit changes";
};

const isArtifactDiagnostic = (file: string): boolean =>
  file.startsWith("artifacts/") || file.includes("/artifacts/") || file.endsWith(".tsx");

export type CheckDetail = "compact" | "full";

export interface DiagnosticView extends ProjectDiagnostic {
  readonly origin: "worker" | "artifact";
  /**
   * Set when an artifact diagnostic is best explained by a worker diagnostic
   * (typically a broken shared `src/api.ts`), rather than a separate failure.
   */
  readonly downstreamOf?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly code: string;
  };
}

const diagnosticKey = (diagnostic: ProjectDiagnostic): string =>
  [
    diagnostic.file,
    diagnostic.line,
    diagnostic.column,
    diagnostic.code,
    diagnostic.message,
  ].join("\u0000");

/** Missing exports/modules cascade into every artifact that imports them. */
const cascadeCodes = new Set(["TS2305", "TS2307", "TS2724"]);

const mentionsFile = (message: string, file: string): boolean => {
  const normalized = toPosix(file);
  return (
    message.includes(normalized) ||
    message.includes("./" + normalized) ||
    message.includes(normalized.replace(/^\.\//, ""))
  );
};

/**
 * Deduplicate diagnostics and separate worker errors from artifact build
 * errors. Artifact errors that name a worker file (or share a missing-export
 * code) are marked as downstream so the author fixes the worker file first.
 */
export const classifyDiagnostics = (
  diagnostics: ReadonlyArray<ProjectDiagnostic>,
): ReadonlyArray<DiagnosticView> => {
  const seen = new Set<string>();
  const unique: Array<ProjectDiagnostic> = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  const workers = unique.filter((diagnostic) => !isArtifactDiagnostic(diagnostic.file));
  return unique.map((diagnostic): DiagnosticView => {
    const origin = isArtifactDiagnostic(diagnostic.file) ? "artifact" : "worker";
    if (origin === "worker") return { ...diagnostic, origin };
    const downstream =
      workers.find((worker) => mentionsFile(diagnostic.message, worker.file)) ??
      (cascadeCodes.has(diagnostic.code)
        ? workers.find((worker) => worker.code === diagnostic.code)
        : undefined);
    return downstream === undefined
      ? { ...diagnostic, origin }
      : {
          ...diagnostic,
          origin,
          downstreamOf: {
            file: downstream.file,
            line: downstream.line,
            column: downstream.column,
            code: downstream.code,
          },
        };
  });
};

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly entry?: string | undefined;
  readonly enabled: boolean;
  /** Service status when this check ran; it is a snapshot, not a live state. */
  readonly serviceStatus: ProjectSummary["status"];
}

export const projectSnapshot = (summary: ProjectSummary): ProjectSnapshot => ({
  id: summary.id,
  name: summary.name,
  root: summary.root,
  ...(summary.entry === undefined ? {} : { entry: summary.entry }),
  enabled: summary.enabled,
  serviceStatus: summary.status,
});

export interface ReloadChangeView {
  readonly kind: ProjectUnitChange["kind"];
  readonly name: string;
  readonly change: ProjectUnitChange["change"];
  readonly source?: SourceLocation | undefined;
}

export interface ReloadView {
  readonly mode: "none" | "artifact-only" | "worker-restart";
  readonly artifactOnly: boolean;
  readonly requiresWorkerRestart: boolean;
  /** Names and change kinds only; `before`/`after` stay in detail: "full". */
  readonly changes: ReadonlyArray<ReloadChangeView>;
}

export const reloadView = (check: CheckResult): ReloadView => {
  const artifactOnly =
    check.changes.length > 0 && check.changes.every((change) => change.kind === "artifact");
  const requiresWorkerRestart = check.changes.some((change) => change.kind !== "artifact");
  return {
    mode: artifactOnly ? "artifact-only" : requiresWorkerRestart ? "worker-restart" : "none",
    artifactOnly,
    requiresWorkerRestart,
    changes: check.changes.map((change) => ({
      kind: change.kind,
      name: change.name,
      change: change.change,
      ...(change.source === undefined ? {} : { source: change.source }),
    })),
  };
};

export const projectSummaryView = (
  project: ProjectSummary,
): {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly entry?: string | undefined;
  readonly enabled: boolean;
  readonly status: ProjectSummary["status"];
  readonly unitCount: number;
} => ({
  id: project.id,
  name: project.name,
  root: project.root,
  ...(project.entry === undefined ? {} : { entry: project.entry }),
  enabled: project.enabled,
  status: project.status,
  unitCount: project.unitCount,
});

const checkDeclarations = (
  check: CheckResult,
  extras: CheckExtras | undefined,
): ReadonlyArray<DeclarationUnitView> => {
  if (extras !== undefined) return extras.declarations;
  return declarationUnits(
    check.manifest ?? check.appliedManifest,
    [],
    check.summary.root,
    check.summary.status === "running",
  );
};

/**
 * Shape the check result for a tool call. Compact is the default: it keeps
 * only what an edit-check loop needs and leaves manifests, unit rows and the
 * full connection inventory to detail: "full".
 */
export const checkData = (
  check: CheckResult,
  extras?: CheckExtras | undefined,
  detail: CheckDetail = "compact",
): unknown => {
  const diagnostics = classifyDiagnostics(check.diagnostics);
  const snapshot = projectSnapshot(check.summary);
  const reload = reloadView(check);
  const requirements = requirementViews(
    check.requirements,
    check.availableConnections,
    check.manifest ?? check.appliedManifest,
  );
  const declarations = checkDeclarations(check, extras);
  const artifacts = extras?.artifacts ?? [];
  const artifactNote =
    extras?.artifactNote === undefined ? {} : { artifactNote: extras.artifactNote };
  if (detail === "full") {
    return {
      ...check,
      summary: { ...check.summary, issues: dedupeIssues(check.summary.issues) },
      detail,
      snapshot,
      diagnostics,
      requirementDetails: requirements,
      artifacts,
      declarations,
      artifactOnly: reload.artifactOnly,
      requiresWorkerRestart: reload.requiresWorkerRestart,
      ...artifactNote,
    };
  }
  return {
    detail,
    ok: check.ok,
    snapshot,
    diagnostics,
    requiresConsent: check.requiresConsent,
    ...(check.pendingConsent === undefined
      ? {}
      : {
          pendingConsent: {
            id: check.pendingConsent.id,
            summary: check.pendingConsent.summary,
            reason: check.pendingConsent.reason,
          },
        }),
    missingConnections: check.missingConnections,
    missingScopes: [...new Set(check.missingScopes)],
    requirements,
    reload,
    declarations,
    artifacts,
    ...artifactNote,
    ...(check.error === undefined ? {} : { error: check.error }),
  };
};

const downstreamText = (diagnostic: DiagnosticView): string =>
  diagnostic.downstreamOf === undefined
    ? ""
    : " [cascades from " +
      diagnostic.downstreamOf.file +
      ":" +
      diagnostic.downstreamOf.line +
      " " +
      diagnostic.downstreamOf.code +
      "]";

export const checkText = (
  check: CheckResult,
  extras?: CheckExtras | undefined,
  options: {
    readonly detail?: CheckDetail | undefined;
    /** ballast_apply already states the next action; skip the check's hint. */
    readonly next?: boolean | undefined;
  } = {},
): string => {
  const detail = options.detail ?? "full";
  const lines: Array<string> = [];
  const summary = check.summary;
  const entry = summary.entry ?? "ballast.ts";
  lines.push(
    "project " +
      summary.id +
      " (" +
      summary.name +
      ") · entry " +
      entry +
      " · service status at check: " +
      summary.status +
      (summary.enabled ? " · enabled" : " · disabled"),
  );
  lines.push(
    "check: " +
      (check.ok ? "ok" : "FAILED") +
      " · " +
      check.units.length +
      " unit" +
      (check.units.length === 1 ? "" : "s") +
      (extras === undefined || extras.declarations.length === 0
        ? ""
        : " · " +
          extras.declarations.length +
          " declaration" +
          (extras.declarations.length === 1 ? "" : "s")) +
      (check.pendingConsent === undefined ? "" : " · pending consent " + check.pendingConsent.id),
  );
  if (check.error !== undefined) {
    const artifactError = /artifact/i.test(check.error);
    lines.push((artifactError ? "[artifact] " : "") + "error: " + check.error);
  }
  const diagnostics = classifyDiagnostics(check.diagnostics);
  if (diagnostics.length > 0) {
    lines.push("diagnostics:");
    for (const diagnostic of diagnostics.slice(0, 20)) {
      lines.push(
        "  " +
          (diagnostic.origin === "artifact" ? "[artifact] " : "") +
          diagnostic.file +
          ":" +
          diagnostic.line +
          ":" +
          diagnostic.column +
          " " +
          diagnostic.code +
          " " +
          diagnostic.message +
          downstreamText(diagnostic),
      );
    }
    if (diagnostics.length > 20) lines.push("  … " + (diagnostics.length - 20) + " more");
  }
  if (detail === "full" && check.units.length > 0) {
    lines.push("units:");
    for (const unit of check.units.slice(0, 40)) {
      lines.push(
        "  " +
          unit.kind +
          " " +
          unit.name +
          sourceText(unit) +
          " — " +
          unitDetail(unit, check.manifest),
      );
    }
    if (check.units.length > 40) lines.push("  … " + (check.units.length - 40) + " more");
  }
  if (extras?.artifactNote !== undefined) {
    lines.push("artifacts: unavailable — " + extras.artifactNote);
  }
  if (extras !== undefined && extras.declarations.length > 0) {
    lines.push(
      extras.declarations.some((declaration) => declaration.kind === "artifact")
        ? "artifacts, api and stores:"
        : "api and stores:",
    );
    for (const declaration of extras.declarations) {
      lines.push(
        "  " +
          declaration.kind +
          " " +
          declaration.name +
          (declaration.source === undefined
            ? ""
            : " @ " + declaration.source.file + ":" + declaration.source.line) +
          " · " +
          declaration.status +
          " — " +
          declaration.detail,
      );
    }
  }
  if (extras !== undefined) {
    const seenArtifacts = new Set<string>();
    for (const artifact of extras.artifacts) {
      if (artifact.status !== "error" || seenArtifacts.has(artifact.name)) continue;
      seenArtifacts.add(artifact.name);
      lines.push(
        "artifact build failed: " +
          artifact.name +
          (artifact.error === undefined ? "" : " — " + artifact.error),
      );
    }
  }
  if (check.changes.length > 0) {
    lines.push("diff:");
    for (const change of check.changes.slice(0, 30)) {
      lines.push(
        "  " +
          changePrefix(change.change) +
          " " +
          change.kind +
          " " +
          change.name +
          (change.source === undefined
            ? ""
            : " @ " + change.source.file + ":" + change.source.line) +
          (change.kind === "database" && change.change === "removed"
            ? " (data kept: .ballast/db/" + change.name + ".sqlite)"
            : ""),
      );
    }
  }
  lines.push(
    "reload: " + changeSummary(check, extras) + " · requiresConsent: " +
      (check.requiresConsent ? "yes" : "no") +
      " · applied manifest: " +
      (check.appliedManifest === undefined ? "none" : "present"),
  );
  if (check.pendingConsent !== undefined) {
    lines.push(
      "pending consent: " +
        check.pendingConsent.summary +
        " (" +
        check.pendingConsent.reason +
        ")",
    );
  }
  const views = requirementViews(
    check.requirements,
    check.availableConnections,
    check.manifest ?? check.appliedManifest,
  );
  if (views.length > 0) {
    lines.push("requirements:");
    for (const view of views) {
      lines.push("  " + requirementLine(view));
    }
  }
  const attributedScopes = new Set(views.flatMap((view) => view.missingScopes));
  const extraScopes = check.missingScopes.filter((scope) => !attributedScopes.has(scope));
  if (extraScopes.length > 0) {
    lines.push("missing scopes: " + extraScopes.join(", "));
  }
  if (options.next === false) return lines.join("\n");
  if (!check.ok) {
    lines.push("next: fix the diagnostics, then run ballast_check again.");
  } else if (check.requiresConsent || check.missingConnections.length > 0 || check.missingScopes.length > 0) {
    lines.push(
      "next: the user must configure missing connections and approve consent in the Ballast app; ballast_apply never approves.",
    );
  } else {
    lines.push("next: ballast_apply requests a reload.");
  }
  return lines.join("\n");
};

export const applyProject = (
  adapter: ProjectAdapter,
  project: ProjectSummary,
): Effect.Effect<ApplyOutcome, ToolError> =>
  Effect.gen(function* () {
    const check = yield* adapter.checkProject(project.id);
    if (!check.ok) {
      return {
        state: "error" as const,
        reason: "invalid" as const,
        message: "The latest project files do not plan. Fix the diagnostics, then run ballast_check again.",
        check,
      };
    }
    const detail = yield* adapter.getProject(project.id);
    const unbound = check.requirements.filter(
      (requirement) => requirement.boundInstanceId === undefined,
    );
    if (unbound.length > 0) {
      const slots = unbound
        .map((requirement) => requirement.integration + "/" + requirement.slot)
        .join(", ");
      return {
        state: "waiting_for_user" as const,
        reason: "connections" as const,
        message:
          "These project slots need a connection: " +
          slots +
          ". Open the Ballast app, create or assign a connection for each slot, then start the project (Start confirms a proposed instance). The MCP never binds connections.",
        check,
        project: detail.summary,
      };
    }
    if (check.requiresConsent || check.pendingConsent !== undefined || detail.pendingConsent !== undefined) {
      return {
        state: "waiting_for_user" as const,
        reason: "consent" as const,
        message:
          "Consent is required before this reload. Open the Ballast app and approve the pending permission request; the MCP never grants scopes or approves consent.",
        check,
        project: detail.summary,
      };
    }
    if (check.missingScopes.length > 0) {
      return {
        state: "waiting_for_user" as const,
        reason: "scopes" as const,
        message:
          "The account is missing scopes. Open the Ballast app, reconnect the connection and grant the listed scopes.",
        check,
        project: detail.summary,
      };
    }
    if (detail.summary.enabled !== true || detail.appliedAt === undefined) {
      return {
        state: "waiting_for_user" as const,
        reason: "start" as const,
        message:
          "This project has not been started. The first start is user-only: open the Ballast app and press Start for this project, then use ballast_status.",
        check,
        project: detail.summary,
      };
    }
    const restarted = yield* adapter.restartProject(project.id).pipe(Effect.result);
    if (Result.isFailure(restarted)) {
      return {
        state: "error" as const,
        reason: "reload" as const,
        message: "The reload failed: " + restarted.failure.message,
        check,
        project: detail.summary,
      };
    }
    if (restarted.success.pendingConsent !== undefined) {
      return {
        state: "waiting_for_user" as const,
        reason: "consent" as const,
        message:
          "The reload planned a new permission request. Open the Ballast app and approve it; the previous version keeps running.",
        check,
        project: restarted.success.summary,
      };
    }
    if (restarted.success.summary.status === "failed") {
      const issue = restarted.success.summary.issues[0];
      return {
        state: "error" as const,
        reason: "reload" as const,
        message:
          "The reload did not start: " +
          (issue?.detail ?? issue?.title ?? "the project reported an error") +
          ". The previous version keeps running.",
        check,
        project: restarted.success.summary,
      };
    }
    if (restarted.success.summary.status !== "running") {
      return {
        state: "error" as const,
        reason: "reload" as const,
        message:
          "Reload requested, but the project is now " +
          restarted.success.summary.status +
          ".",
        check,
        project: restarted.success.summary,
      };
    }
    // Drop the pre-reload check snapshot: its service status is stale now
    // that the restart succeeded. Callers read state/project for the reload
    // outcome and can run ballast_status for a fresh snapshot.
    return {
      state: "running" as const,
      message: "Reloaded and running the latest bundle.",
      project: restarted.success.summary,
    };
  });
