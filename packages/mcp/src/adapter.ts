import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  ConnectionSummary,
  HealthStatus,
  ProjectCheckResult,
  ProjectDetail,
  ProjectManifest,
  ProjectRequirement,
  ProjectSummary,
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
  ) => Effect.Effect<ProjectDetail, ToolError>;
  readonly checkProject: (projectId: string) => Effect.Effect<CheckResult, ToolError>;
  readonly restartProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly listConnections: () => Effect.Effect<ReadonlyArray<ConnectionSummary>, ToolError>;
  readonly health: () => Effect.Effect<HealthStatus, ToolError>;
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

const normalizeDetail = (detail: ProjectDetail): ProjectDetail => ({
  ...detail,
  units: detail.units.map((unit) =>
    normalizeUnit(detail.summary.root, unit, detail.manifest),
  ),
  ...(detail.lastErrorSource === undefined
    ? {}
    : {
        lastErrorSource:
          normalizeSourceLocation(detail.summary.root, detail.lastErrorSource) ??
          detail.lastErrorSource,
      }),
});

const normalizeCheck = (check: CheckResult): CheckResult => ({
  ...check,
  units: check.units.map((unit) =>
    normalizeUnit(check.summary.root, unit, check.manifest ?? check.appliedManifest),
  ),
  changes: check.changes.map((change) => {
    const source = normalizeSourceLocation(check.summary.root, change.source);
    return { ...change, ...(source === undefined ? {} : { source }) };
  }),
});

export const makeProjectAdapter = (gateway: AgentGateway): ProjectAdapter => {
  const resolveProject = (reference: string): Effect.Effect<ProjectSummary, ToolError> =>
    Effect.gen(function* () {
      const trimmed = reference.trim();
      if (trimmed === "") {
        return yield* Effect.fail(toolError("A project id, name or path is required."));
      }
      const projects = yield* gateway.listProjects();
      const byId = projects.find((project) => project.id === trimmed);
      if (byId !== undefined) return byId;

      const lowered = trimmed.toLowerCase();
      const byName = projects.filter((project) => project.name.toLowerCase() === lowered);
      const firstByName = byName[0];
      if (byName.length === 1 && firstByName !== undefined) return firstByName;
      if (byName.length > 1) {
        return yield* Effect.fail(
          toolError(
            "Project name '" +
              trimmed +
              "' is ambiguous: " +
              byName.map((project) => project.id + " (" + project.root + ")").join(", "),
          ),
        );
      }

      const byPath = projects.find((project) => samePath(project.root, trimmed));
      if (byPath !== undefined) return byPath;

      return yield* Effect.fail(
        toolError(
          "No Ballast project matches '" +
            trimmed +
            "'. Known projects: " +
            (projects.length === 0
              ? "none"
              : projects.map((project) => project.id + " (" + project.name + ")").join(", ")) +
            ".",
        ),
      );
    });

  const getProject = (projectId: string): Effect.Effect<ProjectDetail, ToolError> =>
    gateway.getProject(projectId).pipe(Effect.map(normalizeDetail));

  return {
    listProjects: gateway.listProjects,
    resolveProject,
    getProject,
    createProject: (name, directory) =>
      gateway.createProject(name, directory).pipe(Effect.map(normalizeDetail)),
    checkProject: (projectId) =>
      gateway.checkProject(projectId).pipe(Effect.map(normalizeCheck)),
    restartProject: (projectId) =>
      gateway.restartProject(projectId).pipe(Effect.map(normalizeDetail)),
    listConnections: gateway.listConnections,
    health: gateway.health,
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
}

/**
 * Resolve each declared slot to the instance the user sees: an explicit
 * binding, a proposed sole instance, an unbound slot, or a dangling binding.
 */
export const requirementViews = (
  requirements: ReadonlyArray<ProjectRequirement>,
  connections: ReadonlyArray<ConnectionSummary>,
): ReadonlyArray<RequirementView> =>
  requirements.map((requirement) => {
    const compatible = connections.filter(
      (connection) => connection.integration === requirement.integration,
    );
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
      };
    }
    return {
      integration: requirement.integration,
      slot: requirement.slot,
      location: requirement.location,
      state: "unbound",
      compatibleCount: compatible.length,
    };
  });

export const requirementLine = (view: RequirementView): string => {
  const slot = view.integration + "/" + view.slot;
  switch (view.state) {
    case "bound":
      return slot + ' → bound to "' + (view.label ?? view.instanceId) + '" (' + view.status + ")";
    case "missing":
      return slot + ' → bound to "' + view.instanceId + '" (missing)';
    case "proposed":
      return slot + ' → proposed: "' + (view.label ?? view.instanceId) + '" (confirm at Start)';
    case "unbound":
      return view.compatibleCount === 0
        ? slot + " → none: user must add a " + view.integration + " connection in the Ballast app"
        : slot +
            " → unbound: " +
            view.compatibleCount +
            " compatible connection" +
            (view.compatibleCount === 1 ? "" : "s") +
            " available";
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
      return "non-durable run loop";
  }
};

const changePrefix = (change: "added" | "removed" | "changed"): string =>
  change === "added" ? "+" : change === "removed" ? "-" : "~";

export const checkText = (check: CheckResult): string => {
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
      " · status " +
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
      (check.pendingConsent === undefined ? "" : " · pending consent " + check.pendingConsent.id),
  );
  if (check.error !== undefined) lines.push("error: " + check.error);
  if (check.diagnostics.length > 0) {
    lines.push("diagnostics:");
    for (const diagnostic of check.diagnostics.slice(0, 20)) {
      lines.push(
        "  " +
          diagnostic.file +
          ":" +
          diagnostic.line +
          ":" +
          diagnostic.column +
          " " +
          diagnostic.code +
          " " +
          diagnostic.message,
      );
    }
  }
  if (check.units.length > 0) {
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
            : " @ " + change.source.file + ":" + change.source.line),
      );
    }
  }
  lines.push(
    "requiresConsent: " +
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
  if (check.requirements.length > 0) {
    lines.push("requirements:");
    for (const view of requirementViews(check.requirements, check.availableConnections)) {
      lines.push("  " + requirementLine(view));
    }
  }
  if (check.missingScopes.length > 0) {
    lines.push("missing scopes: " + check.missingScopes.join(", "));
  }
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
    if (restarted.success.summary.status === "error") {
      return {
        state: "error" as const,
        reason: "reload" as const,
        message:
          "The reload did not start: " +
          (restarted.success.summary.lastError ?? "the project reported an error") +
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
    return {
      state: "running" as const,
      message: "Reloaded and running the latest bundle.",
      check,
      project: restarted.success.summary,
    };
  });
