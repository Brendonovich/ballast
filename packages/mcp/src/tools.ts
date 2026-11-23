import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";

import type { McpServerService } from "./server-types.ts";
import type {
  ArtifactSummary,
  ConnectionSummary,
  EventRecord,
  LogEntry,
  ProjectDetail,
  ProjectSummary,
  StreamEventsRequest,
  StreamLogsRequest,
  UnitKind,
} from "@ballast/agent-protocol";

import {
  applyProject,
  checkText,
  declarationUnits,
  requirementLine,
  requirementViews,
} from "./adapter.ts";
import type { ProjectAdapter, ProjectState } from "./adapter.ts";
import { formatCatalog, selectCatalog } from "./catalog.ts";
import type { CatalogFilter } from "./catalog.ts";
import { formatUnknown, ToolError, toolError } from "./errors.ts";
import { GUIDE } from "./guide.ts";
import { readEventHistory } from "./history.ts";
import type { EventHistoryEntry } from "./history.ts";

export interface ToolContext {
  readonly adapter: ProjectAdapter;
}

export interface ToolOutput {
  readonly text: string;
  readonly data?: unknown;
  readonly isError?: boolean;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpSchema.ToolJson;
  readonly call: (args: unknown) => Effect.Effect<ToolOutput, ToolError>;
}

const noParams = Schema.Struct({});

const jsonSchemaOf = (schema: Schema.Schema<unknown>): McpSchema.ToolJson => {
  const document = Schema.toJsonSchemaDocument(schema);
  const root: McpSchema.ToolJson = { ...document.schema, type: "object" };
  return Object.keys(document.definitions).length === 0
    ? root
    : { ...root, $defs: document.definitions };
};

const defineTool = <S extends Schema.Top & { readonly DecodingServices: never }>(options: {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly run: (input: S["Type"]) => Effect.Effect<ToolOutput, ToolError>;
}): RegisteredTool => ({
  name: options.name,
  description: options.description,
  inputSchema: jsonSchemaOf(options.parameters),
  call: (args) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(options.parameters)(args === undefined ? {} : args, {
          onExcessProperty: "error",
          errors: "all",
        }),
      catch: (cause) => toolError("Invalid arguments: " + formatUnknown(cause)),
    }).pipe(Effect.flatMap(options.run)),
});

const result = (text: string, data?: unknown): ToolOutput =>
  data === undefined ? { text } : { text, data };

const failed = (message: string): ToolOutput => ({ text: message, isError: true });

const callResult = (output: ToolOutput): McpSchema.CallToolResult => {
  // The MCP result schema encodes JSON values; a JSON round-trip drops
  // undefined optional fields (for example `schema: undefined`) that would
  // otherwise make the transport reject the whole result.
  const structured: unknown =
    output.data === undefined ? undefined : JSON.parse(JSON.stringify(output.data));
  return new McpSchema.CallToolResult({
    content: [{ type: "text", text: output.text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(output.isError === true ? { isError: true } : {}),
  });
};

const timeText = (at: number): string => new Date(at).toISOString().slice(11, 19);

const truncate = (value: string, length = 400): string =>
  value.length <= length ? value : value.slice(0, length - 1) + "…";

const jsonText = (value: unknown, length = 400): string => {
  try {
    return truncate(JSON.stringify(value), length);
  } catch {
    return truncate(String(value), length);
  }
};

const parseSince = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const relative = /^(\d+)\s*(s|m|h|d)$/.exec(trimmed);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - amount * multiplier;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error("since must be an epoch timestamp, an ISO date, or a relative duration such as 10m or 2h");
};

const formatLog = (entry: LogEntry): string => {
  const scope = [
    entry.projectId,
    entry.unitKind === undefined || entry.unitName === undefined
      ? entry.scriptId
      : entry.unitKind + ":" + entry.unitName,
  ]
    .filter((value): value is string => value !== undefined && value !== "")
    .join("/");
  return (
    timeText(entry.at) +
    " " +
    entry.level.toUpperCase() +
    " " +
    entry.source +
    (scope === "" ? "" : " " + scope) +
    " " +
    entry.message +
    (entry.fields === undefined ? "" : " " + jsonText(entry.fields, 240))
  );
};

const formatHistory = (
  entry: EventHistoryEntry,
  topic: { readonly integration: string; readonly topic: string } | undefined,
): string =>
  timeText(entry.receivedAt) +
  " history " +
  entry.subscription +
  (topic === undefined ? "" : " " + topic.integration + "/" + topic.topic) +
  " " +
  jsonText(entry.event, 500) +
  (entry.fingerprint === "" ? "" : " fp=" + entry.fingerprint.slice(0, 12));

const formatEvent = (event: EventRecord): string =>
  timeText(event.at) +
  " " +
  event.direction +
  " " +
  event.topic +
  (event.unitKind === undefined || event.unitName === undefined
    ? ""
    : " [" + event.unitKind + ":" + event.unitName + "]") +
  (event.stale === true ? " STALE" : "") +
  (event.dropped === true ? " DROPPED" : "") +
  " " +
  jsonText(event.payload, 500);

const unitFilter = (
  adapter: ProjectAdapter,
  projectId: string,
  unit: string | undefined,
): Effect.Effect<
  { readonly unitKind: UnitKind; readonly unitName: string } | undefined,
  ToolError
> =>
  Effect.gen(function* () {
    if (unit === undefined) return undefined;
    const detail = yield* adapter.getProject(projectId);
    const separator = unit.indexOf(":");
    const requestedKind = separator > 0 ? unit.slice(0, separator) : undefined;
    const requestedName = separator > 0 ? unit.slice(separator + 1) : unit;
    const found = detail.units.find(
      (candidate) =>
        candidate.name === requestedName &&
        (requestedKind === undefined || candidate.kind === requestedKind),
    );
    if (found === undefined) {
      return yield* Effect.fail(
        toolError(
          "No unit '" +
            unit +
            "' in project " +
            projectId +
            ". Units: " +
            (detail.units.length === 0
              ? "none"
              : detail.units.map((candidate) => candidate.kind + ":" + candidate.name).join(", ")),
        ),
      );
    }
    return { unitKind: found.kind, unitName: found.name };
  });

export const statusState = (
  project: ProjectSummary,
  detail: ProjectDetail,
): {
  readonly state: ProjectState;
  readonly reason?: "consent" | "connections" | undefined;
} => {
  if ((detail.requirements ?? []).some((requirement) => requirement.boundInstanceId === undefined)) {
    return { state: "waiting_for_user", reason: "connections" };
  }
  if (detail.pendingConsent !== undefined || project.status === "needs-consent") {
    return { state: "waiting_for_user", reason: "consent" };
  }
  if (project.status === "error") {
    return {
      state:
        detail.appliedAt !== undefined && detail.units.some((unit) => unit.status === "active")
          ? "previous_version_running_latest_failed"
          : "error",
    };
  }
  if (project.status === "running") {
    return { state: "running" };
  }
  // The service auto-applies plans with no new permissions, so appliedAt does
  // not prove the user ever started the project. Report "stopped"; apply will
  // explain that the first Start is user-only.
  return { state: "stopped" };
};

const formatStatus = (
  detail: ProjectDetail,
  connections: ReadonlyArray<ConnectionSummary>,
  artifacts: ReadonlyArray<ArtifactSummary>,
): ToolOutput => {
  const project = detail.summary;
  const requirements = requirementViews(
    detail.requirements ?? [],
    connections,
    detail.manifest,
  );
  const declarations = declarationUnits(
    detail.manifest,
    artifacts,
    detail.summary.root,
    detail.summary.status === "running",
  );
  const attributedScopes = new Set(requirements.flatMap((view) => view.missingScopes));
  const extraScopes = [
    ...new Set([
      ...(detail.pendingConsent?.diff.added.scopes ?? []),
      ...connections.flatMap((connection) => connection.scopes.missing),
    ]),
  ].filter((scope) => !attributedScopes.has(scope));
  const state = statusState(project, detail);
  const lines: Array<string> = [
    "project " +
      project.id +
      " (" +
      project.name +
      ") · " +
      state.state +
      (state.reason === undefined ? "" : " (" + state.reason + ")") +
      " · " +
      (project.enabled ? "enabled" : "disabled") +
      (project.entry === undefined ? "" : " · entry " + project.entry),
    "root " + project.root,
    "units " +
      detail.units.length +
      " · applied " +
      (detail.appliedAt === undefined ? "never" : new Date(detail.appliedAt).toISOString()),
  ];
  if (project.lastError !== undefined) {
    lines.push(
      "last error: " +
        project.lastError +
        (detail.lastErrorSource === undefined
          ? ""
          : " @ " +
            detail.lastErrorSource.file +
            ":" +
            detail.lastErrorSource.line +
            ":" +
            detail.lastErrorSource.column),
    );
  }
  if (detail.pendingConsent !== undefined) {
    lines.push(
      "pending consent: " +
        detail.pendingConsent.summary +
        " (" +
        detail.pendingConsent.reason +
        "; id " +
        detail.pendingConsent.id +
        ")",
    );
  }
  if (requirements.length > 0) {
    lines.push("requirements:");
    for (const requirement of requirements) {
      lines.push("  " + requirementLine(requirement));
    }
  }
  if (extraScopes.length > 0) {
    lines.push("missing scopes: " + extraScopes.join(", "));
  }
  if (artifacts.length > 0) {
    lines.push("artifacts:");
    for (const artifact of artifacts) {
      lines.push(
        "  " +
          artifact.name +
          (artifact.title === undefined ? "" : ' ("' + artifact.title + '")') +
          " · " +
          artifact.status +
          " · " +
          artifact.entry +
          (artifact.error === undefined ? "" : " — " + artifact.error),
      );
    }
  }
  const declarationUnitsWithoutArtifacts = declarations.filter(
    (declaration) => declaration.kind !== "artifact",
  );
  if (detail.units.length > 0 || declarationUnitsWithoutArtifacts.length > 0) {
    lines.push("units:");
    for (const declaration of declarationUnitsWithoutArtifacts) {
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
    for (const unit of detail.units.slice(0, 40)) {
      lines.push(
        "  " +
          unit.kind +
          " " +
          unit.name +
          " · " +
          unit.status +
          (unit.source === undefined ? "" : " @ " + unit.source.file + ":" + unit.source.line),
      );
    }
  }
  return result(lines.join("\n"), {
    state: state.state,
    ...(state.reason === undefined ? {} : { reason: state.reason }),
    project,
    units: detail.units,
    requirements,
    artifacts,
    declarations,
    missingConnections: (detail.requirements ?? []).filter(
      (requirement) => requirement.boundInstanceId === undefined,
    ),
    missingScopes: [
      ...new Set([...attributedScopes, ...extraScopes]),
    ],
    ...(detail.pendingConsent === undefined ? {} : { pendingConsent: detail.pendingConsent }),
    ...(detail.lastErrorSource === undefined ? {} : { lastErrorSource: detail.lastErrorSource }),
  });
};

const tools = (context: ToolContext): ReadonlyArray<RegisteredTool> => [
  defineTool({
    name: "ballast_guide",
    description:
      "Read this before writing or changing a Ballast project. It is the authoring contract: imports, the ballast.ts entry and modules, params, connections, named subscribe and Ballast.run, Twitch account.helix scopes, durable Ballast.Timer instead of Effect.sleep, init-declares/handlers-act, plan/apply/consent, and a complete example. Call it once per session and again when an API error is unclear.",
    parameters: noParams,
    run: () => Effect.succeed(result(GUIDE)),
  }),
  defineTool({
    name: "ballast_catalog",
    description:
      "List Ballast integrations, their event topics (with Effect-Schema-derived JSON Schemas), requests (with input/output schemas and required scopes) and connection kinds. Without filters this returns a compact integration summary. Pass integration to focus on one, topic/request to pick one entry, search to match names, and includeSchemas: true only when you need the payload shape. Results are paged: if the text says truncated, call again with offset (or narrow with search/topic/request). The OBS/Twitch/VTube Studio catalogs are large. Read ballast_guide before using a topic or request.",
    parameters: Schema.Struct({
      integration: Schema.optionalKey(Schema.String),
      kind: Schema.optionalKey(Schema.Literals(["topics", "requests", "connections", "all"])),
      search: Schema.optionalKey(Schema.String),
      topic: Schema.optionalKey(Schema.String),
      request: Schema.optionalKey(Schema.String),
      includeSchemas: Schema.optionalKey(Schema.Boolean),
      limit: Schema.optionalKey(Schema.Number),
      offset: Schema.optionalKey(Schema.Number),
    }),
    run: (input) =>
      Effect.try({
        try: () => {
          const filter: CatalogFilter = {
            ...(input.integration === undefined ? {} : { integration: input.integration }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.search === undefined ? {} : { search: input.search }),
            ...(input.topic === undefined ? {} : { topic: input.topic }),
            ...(input.request === undefined ? {} : { request: input.request }),
            ...(input.includeSchemas === undefined ? {} : { includeSchemas: input.includeSchemas }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
          };
          const selection = selectCatalog(filter);
          return result(formatCatalog(selection), selection);
        },
        catch: (cause) => toolError("Catalog failed: " + formatUnknown(cause)),
      }),
  }),
  defineTool({
    name: "ballast_project_init",
    description:
      "Create and register a Ballast project through the running service: ballast.ts, package.json (ballast.entry), tsconfig.json and a short AGENTS.md pointing at ballast_guide. Set artifact: true to copy the Solid artifact template (src/api.ts and artifacts/dashboard/main.tsx). The service refuses a non-empty folder. This does not start the project; the first Start is a user action in the Ballast app. Use ballast_check next.",
    parameters: Schema.Struct({
      name: Schema.String,
      dir: Schema.optionalKey(Schema.String),
      artifact: Schema.optionalKey(Schema.Boolean),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const detail = yield* context.adapter.createProject(
          input.name,
          input.dir,
          input.artifact,
        );
        const project = detail.summary;
        const listing = yield* context.adapter.listProjectFiles(project.id);
        const files = listing.files
          .filter((file) => file.kind === "file")
          .map((file) => file.path);
        const text = [
          "created project " + project.id + " (" + project.name + ")",
          "root " + project.root,
          "files: " + (files.length === 0 ? "none" : files.join(", ")),
          "next: edit ballast.ts, then call ballast_check with project '" + project.id + "'.",
        ].join("\n");
        return result(text, { project, root: project.root, files });
      }),
  }),
  defineTool({
    name: "ballast_check",
    description:
      "Typecheck, bundle and plan a registered Ballast project WITHOUT applying or starting it. Returns worker and artifact diagnostics (file, line, column, code, message), planned units and sources, artifact/API/store declarations, artifact build status, the diff from the applied manifest, and whether changes are artifact-only (hot reload, worker stays) or restart the worker. Also reports requiresConsent, missing scopes, and every connection requirement (bound/proposed/unbound/missing). Use after every edit. On a failed build the previously running version is untouched.",
    parameters: Schema.Struct({
      project: Schema.String,
    }),
    run: (input) =>
      Effect.gen(function* () {
        const project = yield* context.adapter.resolveProject(input.project);
        const check = yield* context.adapter.checkProject(project.id);
        const artifacts = yield* context.adapter
          .listArtifacts(project.id)
          .pipe(Effect.catch(() => Effect.succeed([])));
        const declarations = declarationUnits(
          check.manifest ?? check.appliedManifest,
          artifacts,
          check.summary.root,
          check.summary.status === "running",
        );
        const extras = {
          artifacts,
          declarations,
          artifactOnly:
            check.changes.length > 0 &&
            check.changes.every((change) => change.kind === "artifact"),
          requiresWorkerRestart: check.changes.some((change) => change.kind !== "artifact"),
        };
        return result(checkText(check, extras), {
          ...check,
          requirementDetails: requirementViews(
            check.requirements,
            check.availableConnections,
            check.manifest ?? check.appliedManifest,
          ),
          ...extras,
        });
      }),
  }),
  defineTool({
    name: "ballast_apply",
    description:
      "Request a reload of a checked Ballast project. Consent, connection bindings and the first start are USER-ONLY: this tool never grants scopes, approves consent, binds slots or starts a project that has never been started. It returns state=waiting_for_user with reason connections (naming the unbound slots), consent, scopes or start, and the exact action the user must take in the Ballast app; state=running after a running project restarts. Never call it as a substitute for user approval.",
    parameters: Schema.Struct({
      project: Schema.String,
    }),
    run: (input) =>
      Effect.gen(function* () {
        const project = yield* context.adapter.resolveProject(input.project);
        const outcome = yield* applyProject(context.adapter, project);
        const lines = ["apply: " + outcome.state + (outcome.reason === undefined ? "" : " (" + outcome.reason + ")"), outcome.message];
        if (outcome.check !== undefined) {
          lines.push("", checkText(outcome.check));
        }
        return result(lines.join("\n"), outcome);
      }),
  }),
  defineTool({
    name: "ballast_status",
    description:
      "Report the service and one project (or all projects): running, waiting_for_user (with reason), previous_version_running_latest_failed, stopped or error; artifacts with build status; artifact/API/store declarations; every connection requirement as bound, proposed, unbound or missing; missing scopes; and per-unit status and source links. Call it after ballast_apply or when the user asks what Ballast is doing. This is a snapshot; it does not plan or change anything.",
    parameters: Schema.Struct({
      project: Schema.optionalKey(Schema.String),
    }),
    run: (input) =>
      Effect.gen(function* () {
        if (input.project !== undefined) {
          const project = yield* context.adapter.resolveProject(input.project);
          const detail = yield* context.adapter.getProject(project.id);
          const connections = yield* context.adapter.listConnections();
          const artifacts = yield* context.adapter
            .listArtifacts(project.id)
            .pipe(Effect.catch(() => Effect.succeed([])));
          return formatStatus(detail, connections, artifacts);
        }
        const [projects, health] = yield* Effect.all([
          context.adapter.listProjects(),
          context.adapter.health(),
        ]);
        const lines: Array<string> = [
          "Ballast service: " +
            (health.ok ? "ok" : "unhealthy") +
            " · projects " +
            health.projects.total +
            " (" +
            health.projects.running +
            " running, " +
            health.projects.needsConsent +
            " need consent, " +
            health.projects.error +
            " error) · connections " +
            health.connections.connected +
            "/" +
            health.connections.total +
            " · cloud " +
            health.cloud,
        ];
        if (projects.length === 0) {
          lines.push("No projects are registered. Use ballast_project_init.");
        } else {
          for (const project of projects) {
            lines.push(
              "- " +
                project.id +
                " (" +
                project.name +
                ") · " +
                project.status +
                (project.enabled ? " · enabled" : " · disabled") +
                " · " +
                project.unitCount +
                " units" +
                (project.lastError === undefined ? "" : " · error: " + truncate(project.lastError, 160)),
            );
          }
        }
        return result(lines.join("\n"), { health, projects });
      }),
  }),
  defineTool({
    name: "ballast_logs",
    description:
      "Return recent Ballast service logs for a project, optionally filtered to one unit. The unit may be a name or kind:name (for example run:ready); the service receives both unitKind and unitName. Use after applying a change or when a handler misbehaves. Since accepts an epoch millisecond timestamp, an ISO date or a relative duration such as 10m or 2h; limit defaults to 100 (max 2000). The result is a snapshot from the service ring buffer, not a live tail.",
    parameters: Schema.Struct({
      project: Schema.String,
      unit: Schema.optionalKey(Schema.String),
      since: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const project = yield* context.adapter.resolveProject(input.project);
        const since = yield* Effect.try({
          try: () => parseSince(input.since),
          catch: (cause) => toolError(formatUnknown(cause)),
        });
        const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 2000));
        const filter = yield* unitFilter(context.adapter, project.id, input.unit);
        const request: StreamLogsRequest = {
          projectId: project.id,
          ...(filter === undefined
            ? {}
            : { unitKind: filter.unitKind, unitName: filter.unitName }),
        };
        const entries = yield* context.adapter.logs(request, 2000);
        const filtered = entries
          .filter((entry) => since === undefined || entry.at >= since)
          .filter(
            (entry) =>
              filter === undefined ||
              (entry.unitKind === filter.unitKind && entry.unitName === filter.unitName),
          )
          .slice(-limit);
        const text =
          filtered.length === 0
            ? "No logs matched."
            : filtered.map(formatLog).join("\n");
        return result(text, {
          projectId: project.id,
          count: filtered.length,
          logs: filtered,
        });
      }),
  }),
  defineTool({
    name: "ballast_events",
    description:
      "Return recent events for a project from both durable subscription history (inbound, survives reloads) and the live event ring (including outbound requests). Filter by subscription name, unit (name or kind:name), integration or topic. Since accepts epoch ms, an ISO date or a relative duration like 10m; limit defaults to 50 (max 500). Use it to see whether a subscription fired and what payload the handler received. This is a snapshot, not a live tail.",
    parameters: Schema.Struct({
      project: Schema.String,
      subscription: Schema.optionalKey(Schema.String),
      unit: Schema.optionalKey(Schema.String),
      integration: Schema.optionalKey(Schema.String),
      topic: Schema.optionalKey(Schema.String),
      since: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const project = yield* context.adapter.resolveProject(input.project);
        const detail = yield* context.adapter.getProject(project.id);
        const since = yield* Effect.try({
          try: () => parseSince(input.since),
          catch: (cause) => toolError(formatUnknown(cause)),
        });
        const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 500));
        const filter = yield* unitFilter(context.adapter, project.id, input.unit);
        const request: StreamEventsRequest = {
          projectId: project.id,
          ...(filter === undefined
            ? {}
            : { unitKind: filter.unitKind, unitName: filter.unitName }),
          ...(input.integration === undefined ? {} : { integration: input.integration }),
          ...(input.topic === undefined ? {} : { topic: input.topic }),
        };
        const events = yield* context.adapter.events(request, 500);
        const filtered = events
          .filter((event) => since === undefined || event.at >= since)
          .filter(
            (event) =>
              filter === undefined ||
              (event.unitKind === filter.unitKind && event.unitName === filter.unitName),
          )
          .filter(
            (event) =>
              input.subscription === undefined ||
              event.unitName === input.subscription,
          )
          .filter((event) => input.integration === undefined || event.integration === input.integration)
          .filter((event) => input.topic === undefined || event.topic === input.topic)
          .slice(-limit);

        const topicBySubscription = new Map(
          detail.manifest.topics.map((topic) => [
            topic.name,
            { integration: topic.integration, topic: topic.topic },
          ]),
        );
        const history = yield* readEventHistory(project.root, {
          ...(input.subscription === undefined ? {} : { subscription: input.subscription }),
          limit: 500,
        }).pipe(Effect.catch(() => Effect.succeed([])));
        const historyFiltered = history
          .filter((entry) => since === undefined || entry.receivedAt >= since)
          .filter(
            (entry) => input.subscription === undefined || entry.subscription === input.subscription,
          )
          .filter(() => filter === undefined || filter.unitKind === "topic")
          .filter((entry) => filter === undefined || entry.subscription === filter.unitName)
          .filter((entry) => {
            if (input.integration === undefined && input.topic === undefined) return true;
            const topic = topicBySubscription.get(entry.subscription);
            if (topic === undefined) return false;
            return (
              (input.integration === undefined || topic.integration === input.integration) &&
              (input.topic === undefined || topic.topic === input.topic)
            );
          })
          .slice(0, limit);

        const parts: Array<string> = [];
        if (historyFiltered.length > 0) {
          parts.push("history:");
          for (const entry of historyFiltered) {
            parts.push("  " + formatHistory(entry, topicBySubscription.get(entry.subscription)));
          }
        }
        if (filtered.length > 0) {
          parts.push("ring:");
          for (const event of filtered) {
            parts.push("  " + formatEvent(event));
          }
        }
        return result(parts.length === 0 ? "No events matched." : parts.join("\n"), {
          projectId: project.id,
          history: historyFiltered,
          count: historyFiltered.length + filtered.length,
          events: filtered,
        });
      }),
  }),
];

export const registerTools = (
  server: McpServerService,
  context: ToolContext,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const tool of tools(context)) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        annotations: Context.empty(),
        handle: (args: unknown) =>
          tool.call(args).pipe(
            Effect.map(callResult),
            Effect.catch((error) => Effect.succeed(callResult(failed(error.message)))),
            Effect.catchCause((cause) =>
              Effect.succeed(callResult(failed("Internal tool error: " + formatUnknown(cause)))),
            ),
          ),
      });
    }
  });
