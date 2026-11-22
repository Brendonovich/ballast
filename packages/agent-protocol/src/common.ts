import { Schema } from "effect";

/**
 * Strings that identify a script inside one project. The agent uses the
 * script's path relative to the project root (for example
 * `scripts/redeem-to-scene.ts`), so ids survive restarts and are meaningful to
 * people reading logs. Ids are unique within a project, not across projects;
 * pair them with a project id. Clients must treat them as opaque.
 */
export const ScriptId = Schema.String;
export type ScriptId = typeof ScriptId.Type;

/**
 * Strings that identify a project (a folder the service watches). Project ids
 * are opaque and stable for the lifetime of the service registration; clients
 * must not derive paths from them.
 */
export const ProjectId = Schema.String;
export type ProjectId = typeof ProjectId.Type;

/**
 * Strings that identify a configured connection. Connections are service-wide
 * (one OBS, one Twitch account) and are shared by every project, so the id is
 * `<integration>/<slot>` (for example `obs/main`). Treat it as opaque: a future
 * version may attach several accounts to one slot.
 */
export const ConnectionId = Schema.String;
export type ConnectionId = typeof ConnectionId.Type;

export const connectionId = (integration: string, slot: string): string =>
  `${integration}/${slot}`;

/** Milliseconds since the Unix epoch, as returned by `Date.now()`. */
export const Timestamp = Schema.Number;
export type Timestamp = typeof Timestamp.Type;

export const ParamType = Schema.Literals(["string", "number", "boolean", "enum"]);
export type ParamType = typeof ParamType.Type;

/** A parameter value that can travel over JSON without losing its type. */
export const ParamValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type ParamValue = typeof ParamValue.Type;

export const ConnectionLocation = Schema.Literals(["local", "cloud", "either"]);
export type ConnectionLocation = typeof ConnectionLocation.Type;

export const ConnectionMode = Schema.Literals(["auto", "local-app", "cloud"]);
export type ConnectionMode = typeof ConnectionMode.Type;

export const ConnectionStatus = Schema.Literals([
  "unconfigured",
  "disconnected",
  "connecting",
  "connected",
  "reauth-required",
  "error",
]);
export type ConnectionStatus = typeof ConnectionStatus.Type;

/**
 * The typed failure every request/response RPC can return. Streaming RPCs use
 * the same shape as their stream error, so a UI can render one error path.
 */
export const AgentError = Schema.Struct({
  tag: Schema.Literals([
    "not-found",
    "invalid",
    "conflict",
    "unauthorized",
    "upstream",
    "internal",
  ]),
  message: Schema.String,
  details: Schema.optionalKey(Schema.Json),
});
export type AgentError = typeof AgentError.Type;

export const agentError = (
  tag: AgentError["tag"],
  message: string,
  details?: Schema.Json,
): AgentError =>
  details === undefined ? { tag, message } : { tag, message, details };

/**
 * Pull the first useful message out of an unknown failure. Services should
 * return `AgentError` deliberately; this is for the boundary where something
 * unexpected happened instead.
 */
export const unexpectedError = (cause: unknown): AgentError =>
  agentError("internal", cause instanceof Error ? cause.message : String(cause));
