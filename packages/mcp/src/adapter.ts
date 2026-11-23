import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type {
  ConnectionStatus,
  ConnectionSummary,
  HealthStatus,
  ProjectDetail,
  ProjectManifest,
  ProjectSummary,
  SourceLocation,
  UnitKind,
} from "@ballast/agent-protocol";
import type { Manifest } from "@ballast/core";
import { planProject, ProjectPlanError } from "@ballast/planner";
import type { TypecheckDiagnostic } from "@ballast/planner";

import type { AgentGateway } from "./client.ts";
import { formatUnknown, ToolError, toolError } from "./errors.ts";

export interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code?: string | undefined;
  readonly message: string;
}

export interface CheckUnit {
  readonly kind: UnitKind;
  readonly name: string;
  readonly source?: SourceLocation | undefined;
  readonly detail: string;
}

export interface UnitChange {
  readonly kind: UnitKind;
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly source?: SourceLocation | undefined;
}

export interface MissingConnection {
  readonly integration: string;
  readonly slot: string;
  readonly location: "local" | "cloud" | "either";
  readonly connectionId?: string | undefined;
  readonly status?: ConnectionStatus | undefined;
}

export interface MissingScopes {
  readonly integration: string;
  readonly slot: string;
  readonly connectionId?: string | undefined;
  readonly scopes: ReadonlyArray<string>;
}

export interface PendingConsentSummary {
  readonly id: string;
  readonly reason: "scopes" | "connections" | "both";
  readonly summary: string;
}

export interface CheckResult {
  readonly project: ProjectSummary;
  readonly entry: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly units: ReadonlyArray<CheckUnit>;
  readonly changes: ReadonlyArray<UnitChange>;
  readonly requiresConsent: boolean;
  readonly missingConnections: ReadonlyArray<MissingConnection>;
  readonly missingScopes: ReadonlyArray<MissingScopes>;
  readonly appliedAt?: number | undefined;
  readonly pendingConsent?: PendingConsentSummary | undefined;
}

export type ApplyState = "reloaded" | "waiting_for_user" | "invalid" | "failed";
export type ApplyReason = "consent" | "start" | "connection" | "scopes";

export interface ApplyOutcome {
  readonly state: ApplyState;
  readonly reason?: ApplyReason | undefined;
  readonly message: string;
  readonly check?: CheckResult | undefined;
  readonly project?: ProjectSummary | undefined;
}

/**
 * The seam between the MCP tools and the agent service. W4 can replace the
 * local planner in `checkProject` with a non-applying PlanProject RPC that
 * returns the same CheckResult fields (see packages/mcp/README.md).
 */
export interface ProjectAdapter {
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectSummary>, ToolError>;
  readonly resolveProject: (reference: string) => Effect.Effect<ProjectSummary, ToolError>;
  readonly getProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly registerProject: (path: string, name?: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly checkProject: (project: ProjectSummary) => Effect.Effect<CheckResult, ToolError>;
  readonly restartProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly listConnections: () => Effect.Effect<ReadonlyArray<ConnectionSummary>, ToolError>;
  readonly health: () => Effect.Effect<HealthStatus, ToolError>;
  readonly logs: AgentGateway["logs"];
  readonly events: AgentGateway["events"];
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Planner source links are project-relative; drop core/internal frames. */
const projectSource = (source: SourceLocation | undefined): SourceLocation | undefined =>
  source === undefined || source.file.startsWith("..") || isAbsolute(source.file)
    ? undefined
    : source;

const samePath = (left: string, right: string): boolean => {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
};

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
            ". Register a folder with ballast_project_init.",
        ),
      );
    });

  const missingConnectionsOf = (
    manifest: ProjectManifest,
    connections: ReadonlyArray<ConnectionSummary>,
  ): ReadonlyArray<MissingConnection> =>
    manifest.connections.flatMap((connection) => {
      const configured = connections.find(
        (candidate) =>
          candidate.integration === connection.integration &&
          candidate.slot === connection.slot,
      );
      if (configured === undefined) {
        return [
          {
            integration: connection.integration,
            slot: connection.slot,
            location: connection.location,
          },
        ];
      }
      if (configured.status === "connected") return [];
      return [
        {
          integration: connection.integration,
          slot: connection.slot,
          location: connection.location,
          connectionId: configured.id,
          status: configured.status,
        },
      ];
    });

  const requiredScopes = (manifest: ProjectManifest): ReadonlyMap<string, ReadonlyArray<string>> => {
    const map = new Map<string, Set<string>>();
    const add = (integration: string, slot: string, scopes: ReadonlyArray<string>) => {
      if (scopes.length === 0) return;
      const key = integration + "/" + slot;
      const set = map.get(key) ?? new Set<string>();
      for (const scope of scopes) set.add(scope);
      map.set(key, set);
    };
    for (const topic of manifest.topics) add(topic.integration, topic.slot, topic.scopes);
    for (const request of manifest.requests) add(request.integration, request.slot, request.scopes);
    return new Map([...map].map(([key, value]) => [key, [...value]]));
  };

  const missingScopesOf = (
    manifest: ProjectManifest,
    connections: ReadonlyArray<ConnectionSummary>,
  ): ReadonlyArray<MissingScopes> => {
    const required = requiredScopes(manifest);
    return [...required].flatMap(([key, scopes]) => {
      const separator = key.indexOf("/");
      const integration = key.slice(0, separator);
      const slot = key.slice(separator + 1);
      const configured = connections.find(
        (candidate) => candidate.integration === integration && candidate.slot === slot,
      );
      const granted = new Set(configured?.scopes.granted ?? []);
      const missing = scopes.filter((scope) => !granted.has(scope));
      if (missing.length === 0) return [];
      return [
        {
          integration,
          slot,
          ...(configured === undefined ? {} : { connectionId: configured.id }),
          scopes: missing,
        },
      ];
    });
  };

  const addScopes = (
    manifest: { readonly topics: ReadonlyArray<{ readonly scopes: ReadonlyArray<string> }>; readonly requests: ReadonlyArray<{ readonly scopes: ReadonlyArray<string> }> },
  ): ReadonlyArray<string> => [
    ...new Set([
      ...manifest.topics.flatMap((topic) => topic.scopes),
      ...manifest.requests.flatMap((request) => request.scopes),
    ]),
  ];

  const requiresConsentFor = (
    applied: ProjectManifest | undefined,
    next: ProjectManifest,
    pending: boolean,
  ): boolean => {
    if (pending) return true;
    const previousScopes = new Set(applied === undefined ? [] : addScopes(applied));
    const nextScopes = addScopes(next);
    if (nextScopes.some((scope) => !previousScopes.has(scope))) return true;
    const previousConnections = new Set(
      applied === undefined
        ? []
        : applied.connections.map(
            (connection) => connection.integration + "/" + connection.slot,
          ),
    );
    return next.connections.some(
      (connection) => !previousConnections.has(connection.integration + "/" + connection.slot),
    );
  };

  const unitsOf = (manifest: Manifest): ReadonlyArray<CheckUnit> => {
    const source = (value: SourceLocation | undefined): SourceLocation | undefined =>
      projectSource(value);
    return [
      ...manifest.topics.map((topic) => ({
        kind: "topic" as const,
        name: topic.name,
        ...(source(topic.source) === undefined ? {} : { source: source(topic.source) }),
        detail: topic.integration + "/" + topic.slot + " " + topic.topic,
      })),
      ...manifest.timers.map((timer) => ({
        kind: "timer" as const,
        name: timer.name,
        ...(source(timer.source) === undefined ? {} : { source: source(timer.source) }),
        detail: "durable timer · " + timer.onStale + " · " + timer.maxAgeMs + "ms",
      })),
      ...manifest.workflows.map((workflow) => ({
        kind: "workflow" as const,
        name: workflow.name,
        ...(source(workflow.source) === undefined ? {} : { source: source(workflow.source) }),
        detail: "durable workflow",
      })),
      ...manifest.params.map((param) => ({
        kind: "param" as const,
        name: param.key,
        ...(source(param.source) === undefined ? {} : { source: source(param.source) }),
        detail:
          "param " +
          param.type +
          (param.default === undefined ? "" : " · default " + JSON.stringify(param.default)),
      })),
      ...manifest.runs.map((run) => ({
        kind: "run" as const,
        name: run.name,
        ...(source(run.source) === undefined ? {} : { source: source(run.source) }),
        detail: "non-durable run loop",
      })),
    ];
  };

  const detailOfUnit = (unit: CheckUnit): string => unit.kind + "/" + unit.name + ":" + unit.detail;

  const changesOf = (
    applied: ProjectManifest | undefined,
    next: Manifest,
  ): ReadonlyArray<UnitChange> => {
    if (applied === undefined) {
      return unitsOf(next).map((unit) => ({
        kind: unit.kind,
        name: unit.name,
        change: "added" as const,
        ...(unit.source === undefined ? {} : { source: unit.source }),
      }));
    }
    const previousUnits = appUnits(applied);
    const nextUnits = unitsOf(next);
    const previous = new Map(previousUnits.map((unit) => [unit.kind + "/" + unit.name, unit]));
    const current = new Map(nextUnits.map((unit) => [unit.kind + "/" + unit.name, unit]));
    const keys = [...new Set([...previous.keys(), ...current.keys()])].sort();
    const changes: Array<UnitChange> = [];
    for (const key of keys) {
      const before = previous.get(key);
      const after = current.get(key);
      if (before === undefined && after !== undefined) {
        changes.push({
          kind: after.kind,
          name: after.name,
          change: "added",
          ...(after.source === undefined ? {} : { source: after.source }),
        });
        continue;
      }
      if (before !== undefined && after === undefined) {
        changes.push({
          kind: before.kind,
          name: before.name,
          change: "removed",
          ...(before.source === undefined ? {} : { source: before.source }),
        });
        continue;
      }
      if (before === undefined || after === undefined) continue;
      if (detailOfUnit(before) === detailOfUnit(after)) continue;
      changes.push({
        kind: after.kind,
        name: after.name,
        change: "changed",
        ...(after.source === undefined ? {} : { source: after.source }),
      });
    }
    return changes;
  };

  const diagnosticsOf = (diagnostics: ReadonlyArray<TypecheckDiagnostic>): ReadonlyArray<Diagnostic> =>
    diagnostics.map((diagnostic) => {
      const code = /^(TS\d+):\s*/.exec(diagnostic.message);
      return {
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
        ...(code === null ? {} : { code: code[1] }),
        message: code === null ? diagnostic.message : diagnostic.message.slice(code[0].length),
      };
    });

  const parseDiagnosticMessage = (message: string): ReadonlyArray<Diagnostic> => {
    const match = /^(.+?):(\d+):(\d+)\s*(?:—|-)\s*(.*)$/.exec(message.trim());
    if (match === null) return [];
    const file = match[1];
    const line = match[2];
    const column = match[3];
    const rest = match[4];
    if (file === undefined || line === undefined || column === undefined || rest === undefined) {
      return [];
    }
    const code = /\b(TS\d+)\b/.exec(rest);
    return [
      {
        file,
        line: Number(line),
        column: Number(column),
        ...(code === null ? {} : { code: code[1] }),
        message: code === null ? rest : rest.replace(code[0] + ": ", "").trim(),
      },
    ];
  };

  const failure = (
    project: ProjectSummary,
    detail: ProjectDetail,
    error: unknown,
    diagnostics: ReadonlyArray<Diagnostic>,
    connections: ReadonlyArray<ConnectionSummary>,
  ): CheckResult => ({
    project,
    entry: project.entry ?? "ballast.ts",
    ok: false,
    error: formatUnknown(error),
    diagnostics,
    units: [],
    changes: [],
    requiresConsent: detail.pendingConsent !== undefined,
    missingConnections: missingConnectionsOf(detail.manifest, connections),
    missingScopes: missingScopesOf(detail.manifest, connections),
    ...(detail.appliedAt === undefined ? {} : { appliedAt: detail.appliedAt }),
    ...(detail.pendingConsent === undefined
      ? {}
      : {
          pendingConsent: {
            id: detail.pendingConsent.id,
            reason: detail.pendingConsent.reason,
            summary: detail.pendingConsent.summary,
          },
        }),
  });

  const checkProject = (project: ProjectSummary): Effect.Effect<CheckResult, ToolError> =>
    Effect.gen(function* () {
      const detail = yield* gateway.getProject(project.id);
      const connections = yield* gateway.listConnections();
      const rootExists = isDirectory(project.root);

      if (!rootExists) {
        // Remote/debug services may be on another machine. Use its plan result
        // as a best effort; W4 should return structured diagnostics here.
        const planned = yield* gateway.planProject(project.id).pipe(Effect.result);
        if (Result.isFailure(planned)) {
          const message = planned.failure.message;
          return failure(project, detail, message, parseDiagnosticMessage(message), connections);
        }
        return checkFromDetail(planned.success, connections);
      }

      const planned = yield* planProject(project.root, { projectId: project.id }).pipe(
        Effect.result,
      );
      if (Result.isFailure(planned)) {
        const error = planned.failure;
        const diagnostics =
          error instanceof ProjectPlanError ? diagnosticsOf(error.diagnostics) : parseDiagnosticMessage(formatUnknown(error));
        return failure(project, detail, error, diagnostics, connections);
      }

      const manifest = planned.success.manifest;
      const wire: ProjectManifest = {
        project: manifest.project,
        params: [],
        connections: manifest.connections.map((connection) => ({
          integration: connection.integration,
          slot: connection.slot,
          location: connection.location,
        })),
        topics: manifest.topics.map((topic) => ({
          name: topic.name,
          integration: topic.integration,
          slot: topic.slot,
          topic: topic.topic,
          scopes: [...topic.scopes],
          onStale: topic.onStale,
          maxAgeMs: topic.maxAgeMs,
          ...(topic.source === undefined ? {} : { source: topic.source }),
        })),
        requests: manifest.requests.map((request) => ({
          integration: request.integration,
          slot: request.slot,
          request: request.request,
          scopes: [...request.scopes],
        })),
        timers: manifest.timers.map((timer) => ({
          name: timer.name,
          ...(timer.source === undefined ? {} : { source: timer.source }),
          ...(timer.title === undefined ? {} : { title: timer.title }),
          onStale: timer.onStale,
          maxAgeMs: timer.maxAgeMs,
          payloadFingerprint: timer.payloadFingerprint,
        })),
        workflows: manifest.workflows.map((workflow) => ({
          name: workflow.name,
          ...(workflow.source === undefined ? {} : { source: workflow.source }),
          ...(workflow.title === undefined ? {} : { title: workflow.title }),
          fingerprint: workflow.fingerprint,
        })),
        runs: manifest.runs.map((run) => ({
          name: run.name,
          ...(run.source === undefined ? {} : { source: run.source }),
        })),
        unresolved: manifest.unresolved.map((entry) => ({ path: entry.path, reason: entry.reason })),
      };

      // The current service detail omits appliedManifest even when appliedAt
      // is set; its manifest is then the last applied plan. W4 should always
      // return appliedManifest so this fallback can disappear.
      const applied =
        detail.appliedManifest ??
        (detail.pendingConsent === undefined && detail.appliedAt !== undefined
          ? detail.manifest
          : undefined);
      const changes = changesOf(applied, manifest);
      return {
        project,
        entry: planned.success.entry.entry,
        ok: true,
        diagnostics: [],
        units: unitsOf(manifest),
        changes,
        requiresConsent: requiresConsentFor(
          applied,
          wire,
          detail.pendingConsent !== undefined,
        ),
        missingConnections: missingConnectionsOf(wire, connections),
        missingScopes: missingScopesOf(wire, connections),
        ...(detail.appliedAt === undefined ? {} : { appliedAt: detail.appliedAt }),
        ...(detail.pendingConsent === undefined
          ? {}
          : {
              pendingConsent: {
                id: detail.pendingConsent.id,
                reason: detail.pendingConsent.reason,
                summary: detail.pendingConsent.summary,
              },
            }),
      };
    });

  const checkFromDetail = (
    detail: ProjectDetail,
    connections: ReadonlyArray<ConnectionSummary>,
  ): CheckResult => {
    const changes: Array<UnitChange> = [];
    const pending = detail.pendingConsent;
    if (pending !== undefined) {
      for (const topic of pending.diff.added.topics) {
        changes.push({
          kind: "topic",
          name: topic.topic,
          change: "added",
        });
      }
      for (const param of pending.diff.added.params) {
        changes.push({ kind: "param", name: param.key, change: "added" });
      }
    }
    return {
      project: detail.summary,
      entry: detail.summary.entry ?? "ballast.ts",
      ok: true,
      diagnostics:
        detail.lastErrorSource === undefined
          ? []
          : [
              {
                file: detail.lastErrorSource.file,
                line: detail.lastErrorSource.line,
                column: detail.lastErrorSource.column,
                message: detail.summary.lastError ?? "Project error",
              },
            ],
      units: detail.units.map((unit) => ({
        kind: unit.kind,
        name: unit.name,
        ...(unit.source === undefined ? {} : { source: unit.source }),
        detail: unit.status,
      })),
      changes,
      requiresConsent: pending !== undefined,
      missingConnections: missingConnectionsOf(detail.manifest, connections),
      missingScopes: missingScopesOf(detail.manifest, connections),
      ...(detail.appliedAt === undefined ? {} : { appliedAt: detail.appliedAt }),
      ...(pending === undefined
        ? {}
        : {
            pendingConsent: {
              id: pending.id,
              reason: pending.reason,
              summary: pending.summary,
            },
          }),
    };
  };

  return {
    listProjects: gateway.listProjects,
    resolveProject,
    getProject: gateway.getProject,
    registerProject: gateway.addProject,
    checkProject,
    restartProject: gateway.restartProject,
    listConnections: gateway.listConnections,
    health: gateway.health,
    logs: gateway.logs,
    events: gateway.events,
  };
};

/** Protocol manifests do not carry the full planned details; this is enough to diff unit identity. */
const appUnits = (manifest: ProjectManifest): ReadonlyArray<CheckUnit> => [
  ...manifest.topics.map((topic) => ({
    kind: "topic" as const,
    name: topic.name,
    ...(projectSource(topic.source) === undefined ? {} : { source: projectSource(topic.source) }),
    detail: topic.integration + "/" + topic.slot + " " + topic.topic,
  })),
  ...manifest.timers.map((timer) => ({
    kind: "timer" as const,
    name: timer.name,
    ...(projectSource(timer.source) === undefined ? {} : { source: projectSource(timer.source) }),
    detail: "durable timer · " + timer.onStale + " · " + timer.maxAgeMs + "ms",
  })),
  ...manifest.workflows.map((workflow) => ({
    kind: "workflow" as const,
    name: workflow.name,
    ...(projectSource(workflow.source) === undefined ? {} : { source: projectSource(workflow.source) }),
    detail: "durable workflow",
  })),
  ...manifest.params.map((param) => ({
    kind: "param" as const,
    name: param.key,
    detail:
      "param " +
      param.type +
      (param.default === undefined ? "" : " · default " + JSON.stringify(param.default)),
  })),
  ...manifest.runs.map((run) => ({
    kind: "run" as const,
    name: run.name,
    ...(projectSource(run.source) === undefined ? {} : { source: projectSource(run.source) }),
    detail: "non-durable run loop",
  })),
];

export const checkText = (check: CheckResult): string => {
  const lines: Array<string> = [];
  const summary = check.project;
  lines.push(
    "project " +
      summary.id +
      " (" +
      summary.name +
      ") · entry " +
      check.entry +
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
          (diagnostic.code === undefined ? "" : diagnostic.code + " ") +
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
          (unit.source === undefined ? "" : " @ " + unit.source.file + ":" + unit.source.line) +
          " — " +
          unit.detail,
      );
    }
    if (check.units.length > 40) lines.push("  … " + (check.units.length - 40) + " more");
  }
  if (check.changes.length > 0) {
    lines.push("diff:");
    for (const change of check.changes.slice(0, 30)) {
      lines.push(
        "  " +
          (change.change === "added" ? "+" : change.change === "removed" ? "-" : "~") +
          " " +
          change.kind +
          " " +
          change.name +
          (change.source === undefined ? "" : " @ " + change.source.file + ":" + change.source.line),
      );
    }
  }
  lines.push(
    "requiresConsent: " +
      (check.requiresConsent ? "yes" : "no") +
      (check.appliedAt === undefined ? " · never applied" : " · applied " + new Date(check.appliedAt).toISOString()),
  );
  if (check.pendingConsent !== undefined) {
    lines.push("pending consent: " + check.pendingConsent.summary + " (" + check.pendingConsent.reason + ")");
  }
  if (check.missingConnections.length > 0) {
    lines.push("missing connections:");
    for (const connection of check.missingConnections) {
      lines.push(
        "  " +
          connection.integration +
          "/" +
          connection.slot +
          (connection.status === undefined ? " (not configured)" : " (" + connection.status + ")"),
      );
    }
  }
  if (check.missingScopes.length > 0) {
    lines.push("missing scopes:");
    for (const missing of check.missingScopes) {
      lines.push("  " + missing.integration + "/" + missing.slot + ": " + missing.scopes.join(", "));
    }
  }
  if (check.requiresConsent || check.missingConnections.length > 0) {
    lines.push(
      "next: the user must configure the missing connections and approve consent in the Ballast app; ballast_apply never approves.",
    );
  } else if (check.ok) {
    lines.push("next: ballast_apply requests a reload.");
  }
  return lines.join("\n");
};

export const applyProject = (
  adapter: ProjectAdapter,
  project: ProjectSummary,
): Effect.Effect<ApplyOutcome, ToolError> =>
  Effect.gen(function* () {
    const check = yield* adapter.checkProject(project);
    if (!check.ok) {
      return {
        state: "invalid" as const,
        message: "The latest project files do not plan. Fix the diagnostics, then run ballast_check again.",
        check,
      };
    }
    const detail = yield* adapter.getProject(project.id);
    if (check.requiresConsent || detail.pendingConsent !== undefined) {
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
    if (check.missingConnections.length > 0) {
      return {
        state: "waiting_for_user" as const,
        reason: "connection" as const,
        message:
          "A connection slot is missing or disconnected. Open the Ballast app, configure and connect it, then retry.",
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
        state: "failed" as const,
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
        state: "failed" as const,
        message:
          "The reload did not start: " +
          (restarted.success.summary.lastError ?? "the project reported an error") +
          ". The previous version keeps running.",
        check,
        project: restarted.success.summary,
      };
    }
    return {
      state: "reloaded" as const,
      message:
        restarted.success.summary.status === "running"
          ? "Reloaded and running the latest bundle."
          : "Reload requested; the project is " + restarted.success.summary.status + ".",
      check,
      project: restarted.success.summary,
    };
  });
