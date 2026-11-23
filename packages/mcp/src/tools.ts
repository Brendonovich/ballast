import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";

import type { McpServerService } from "./server-types.ts";
import type {
  ConnectionSummary,
  EventRecord,
  LogEntry,
  ProjectDetail,
  ProjectManifest,
  ProjectSummary,
  StreamEventsRequest,
  StreamLogsRequest,
} from "@ballast/agent-protocol";

import { applyProject, checkText } from "./adapter.ts";
import type { ProjectAdapter } from "./adapter.ts";
import { formatCatalog, selectCatalog } from "./catalog.ts";
import type { CatalogFilter } from "./catalog.ts";
import { formatUnknown, ToolError, toolError } from "./errors.ts";
import { GUIDE } from "./guide.ts";
import { initProject } from "./scaffold.ts";

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
      try: () => Schema.decodeUnknownSync(options.parameters)(args === undefined ? {} : args),
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

const projectGaps = (
  manifest: ProjectManifest,
  connections: ReadonlyArray<ConnectionSummary>,
): {
  readonly missingConnections: ReadonlyArray<{
    readonly integration: string;
    readonly slot: string;
    readonly location: "local" | "cloud" | "either";
    readonly status?: string | undefined;
  }>;
  readonly missingScopes: ReadonlyArray<{
    readonly integration: string;
    readonly slot: string;
    readonly scopes: ReadonlyArray<string>;
  }>;
} => {
  const missingConnections: Array<{
    integration: string;
    slot: string;
    location: "local" | "cloud" | "either";
    status?: string;
  }> = [];
  const required = new Map<string, Set<string>>();
  const addScopes = (integration: string, slot: string, scopes: ReadonlyArray<string>) => {
    if (scopes.length === 0) return;
    const key = integration + "/" + slot;
    const set = required.get(key) ?? new Set<string>();
    for (const scope of scopes) set.add(scope);
    required.set(key, set);
  };
  for (const topic of manifest.topics) addScopes(topic.integration, topic.slot, topic.scopes);
  for (const request of manifest.requests) addScopes(request.integration, request.slot, request.scopes);

  for (const connection of manifest.connections) {
    const configured = connections.find(
      (candidate) =>
        candidate.integration === connection.integration && candidate.slot === connection.slot,
    );
    if (configured === undefined) {
      missingConnections.push({
        integration: connection.integration,
        slot: connection.slot,
        location: connection.location,
      });
    } else if (configured.status !== "connected") {
      missingConnections.push({
        integration: connection.integration,
        slot: connection.slot,
        location: connection.location,
        status: configured.status,
      });
    }
  }

  const missingScopes = [...required].flatMap(([key, scopes]) => {
    const separator = key.indexOf("/");
    const integration = key.slice(0, separator);
    const slot = key.slice(separator + 1);
    const configured = connections.find(
      (candidate) => candidate.integration === integration && candidate.slot === slot,
    );
    const granted = new Set(configured?.scopes.granted ?? []);
    const missing = [...scopes].filter((scope) => !granted.has(scope));
    return missing.length === 0 ? [] : [{ integration, slot, scopes: missing }];
  });

  return { missingConnections, missingScopes };
};

const statusState = (
  project: ProjectSummary,
  detail: ProjectDetail,
  missingConnections: ReadonlyArray<unknown>,
): string => {
  if (detail.pendingConsent !== undefined) return "waiting_for_user_consent";
  if (project.status === "error") {
    return detail.appliedAt !== undefined && detail.units.some((unit) => unit.status === "active")
      ? "previous_version_running_latest_failed"
      : "error";
  }
  if (project.status === "running") {
    return missingConnections.length > 0 ? "running_missing_connections" : "running";
  }
  // The service auto-applies plans with no new permissions, so appliedAt does
  // not prove the user ever started the project. Report "stopped"; apply will
  // explain that the first Start is user-only.
  return "stopped";
};

const formatStatus = (
  detail: ProjectDetail,
  connections: ReadonlyArray<ConnectionSummary>,
): ToolOutput => {
  const project = detail.summary;
  const gaps = projectGaps(detail.manifest, connections);
  const state = statusState(project, detail, gaps.missingConnections);
  const lines: Array<string> = [
    "project " +
      project.id +
      " (" +
      project.name +
      ") · " +
      state +
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
  if (gaps.missingConnections.length > 0) {
    lines.push("missing connections:");
    for (const connection of gaps.missingConnections) {
      lines.push(
        "  " +
          connection.integration +
          "/" +
          connection.slot +
          (connection.status === undefined ? " (not configured)" : " (" + connection.status + ")"),
      );
    }
  }
  if (gaps.missingScopes.length > 0) {
    lines.push("missing scopes:");
    for (const missing of gaps.missingScopes) {
      lines.push("  " + missing.integration + "/" + missing.slot + ": " + missing.scopes.join(", "));
    }
  }
  if (detail.units.length > 0) {
    lines.push("units:");
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
    state,
    project,
    units: detail.units,
    missingConnections: gaps.missingConnections,
    missingScopes: gaps.missingScopes,
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
      "List Ballast integrations, their event topics (with Effect-Schema-derived JSON Schemas), requests (with input/output schemas and required scopes) and connection kinds. Without filters this returns a compact integration summary. Pass integration to focus on one, search to match topic/request names, and includeSchemas: true only when you need the payload shape; the OBS/Twitch/VTube Studio catalogs are large. Read ballast_guide before using a topic or request.",
    parameters: Schema.Struct({
      integration: Schema.optionalKey(Schema.String),
      kind: Schema.optionalKey(Schema.Literals(["topics", "requests", "connections", "all"])),
      search: Schema.optionalKey(Schema.String),
      includeSchemas: Schema.optionalKey(Schema.Boolean),
      limit: Schema.optionalKey(Schema.Number),
    }),
    run: (input) =>
      Effect.try({
        try: () => {
          const filter: CatalogFilter = {
            ...(input.integration === undefined ? {} : { integration: input.integration }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.search === undefined ? {} : { search: input.search }),
            ...(input.includeSchemas === undefined ? {} : { includeSchemas: input.includeSchemas }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
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
      "Create a Ballast project folder and register it with the running service: ballast.ts, package.json (ballast.entry), tsconfig.json and a short AGENTS.md pointing at ballast_guide. Existing files are never overwritten. This does not start the project; the first Start is a user action in the Ballast app. Use ballast_check next.",
    parameters: Schema.Struct({
      dir: Schema.String,
      name: Schema.optionalKey(Schema.String),
    }),
    run: (input) =>
      Effect.gen(function* () {
        const scaffold = yield* initProject(context.adapter, input.dir, input.name);
        const text = [
          "registered project " + scaffold.project.summary.id + " (" + scaffold.project.summary.name + ")",
          "root " + scaffold.root,
          "created: " + (scaffold.created.length === 0 ? "none" : scaffold.created.join(", ")),
          "kept existing: " + (scaffold.skipped.length === 0 ? "none" : scaffold.skipped.join(", ")),
          "next: edit ballast.ts, then call ballast_check with project '" + scaffold.project.summary.id + "'.",
        ].join("\n");
        return result(text, {
          project: scaffold.project.summary,
          root: scaffold.root,
          created: scaffold.created,
          skipped: scaffold.skipped,
        });
      }),
  }),
  defineTool({
    name: "ballast_check",
    description:
      "Typecheck, bundle and plan a registered Ballast project WITHOUT applying or starting it. Returns structured diagnostics (file, line, column, TS code, message), the planned units with source links, the diff from the applied manifest, requiresConsent, and the connections/scopes the user must configure. Use after every edit. On a failed build the previously running version is untouched; ballast_status says whether it is still running.",
    parameters: Schema.Struct({
      project: Schema.String,
    }),
    run: (input) =>
      Effect.gen(function* () {
        const project = yield* context.adapter.resolveProject(input.project);
        const check = yield* context.adapter.checkProject(project);
        return result(checkText(check), check);
      }),
  }),
  defineTool({
    name: "ballast_apply",
    description:
      "Request a reload of a checked Ballast project. Consent and the first start are USER-ONLY: this tool never grants scopes, approves consent or starts a project that has never been started. It returns state=waiting_for_user with the exact action the user must take in the Ballast app, or state=reloaded after a running project restarts. Never call it as a substitute for user approval.",
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
      "Report the service and one project (or all projects): running, previous-version-running-latest-failed, waiting for consent, stopped/never started, missing connections and missing scopes, plus per-unit status and source links. Call it after ballast_apply or when the user asks what Ballast is doing. This is a snapshot; it does not plan or change anything.",
    parameters: Schema.Struct({
      project: Schema.optionalKey(Schema.String),
    }),
    run: (input) =>
      Effect.gen(function* () {
        if (input.project !== undefined) {
          const project = yield* context.adapter.resolveProject(input.project);
          const detail = yield* context.adapter.getProject(project.id);
          const connections = yield* context.adapter.listConnections();
          return formatStatus(detail, connections);
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
      "Return recent Ballast service logs for a project, optionally filtered to one unit. Use after applying a change or when a handler misbehaves. Since accepts an epoch millisecond timestamp, an ISO date or a relative duration such as 10m or 2h; limit defaults to 100 (max 2000). The result is a snapshot from the service ring buffer, not a live tail.",
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
        const request: StreamLogsRequest = {
          projectId: project.id,
          ...(input.unit === undefined ? {} : { unitName: input.unit }),
        };
        const entries = yield* context.adapter.logs(request, 2000);
        const filtered = entries
          .filter((entry) => since === undefined || entry.at >= since)
          .filter((entry) => input.unit === undefined || entry.unitName === input.unit)
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
      "Return recent inbound events and outbound requests recorded by the Ballast service for a project. Filter by unit, integration or topic. Since accepts epoch ms, an ISO date or a relative duration like 10m; limit defaults to 50 (max 500). Use it to see whether a subscription fired and what payload the handler received. This is a snapshot, not a live tail.",
    parameters: Schema.Struct({
      project: Schema.String,
      unit: Schema.optionalKey(Schema.String),
      integration: Schema.optionalKey(Schema.String),
      topic: Schema.optionalKey(Schema.String),
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
        const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 500));
        const request: StreamEventsRequest = {
          projectId: project.id,
          ...(input.unit === undefined ? {} : { unitName: input.unit }),
          ...(input.integration === undefined ? {} : { integration: input.integration }),
          ...(input.topic === undefined ? {} : { topic: input.topic }),
        };
        const events = yield* context.adapter.events(request, 500);
        const filtered = events
          .filter((event) => since === undefined || event.at >= since)
          .filter((event) => input.unit === undefined || event.unitName === input.unit)
          .filter((event) => input.integration === undefined || event.integration === input.integration)
          .filter((event) => input.topic === undefined || event.topic === input.topic)
          .slice(-limit);
        const text =
          filtered.length === 0
            ? "No events matched."
            : filtered.map(formatEvent).join("\n");
        return result(text, {
          projectId: project.id,
          count: filtered.length,
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
