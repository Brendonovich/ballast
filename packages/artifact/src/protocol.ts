import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

/**
 * Shared key with @ballast/core's Api.action annotation. The gateway can read
 * either module's key because Context identity is the string key.
 */
export const ArtifactAction = Context.Service<boolean>("Ballast/Api/Action");

/** Mark a project API procedure as an action without importing Node core. */
export const action = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(
  rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
): Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires> =>
  rpc.annotate(ArtifactAction, true);

export const ParamValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type ParamValue = Schema.Schema.Type<typeof ParamValue>;

export const ProjectInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  entry: Schema.String,
  status: Schema.Literals(["stopped", "running", "needs-consent", "error"]),
  generation: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  lastError: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      file: Schema.optional(Schema.String),
      line: Schema.optional(Schema.Number),
      column: Schema.optional(Schema.Number),
    }),
  ),
});
export type ProjectInfo = Schema.Schema.Type<typeof ProjectInfo>;

export const Unit = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  status: Schema.optional(Schema.String),
  source: Schema.optional(
    Schema.Struct({
      file: Schema.String,
      line: Schema.Number,
      column: Schema.Number,
    }),
  ),
});
export type Unit = Schema.Schema.Type<typeof Unit>;

export const Param = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["string", "number", "boolean", "enum", "strings"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  value: Schema.Unknown,
  default: Schema.optional(Schema.Unknown),
  options: Schema.optional(Schema.Array(Schema.String)),
  optionsSource: Schema.optional(
    Schema.Struct({
      integration: Schema.String,
      slot: Schema.String,
      source: Schema.String,
    }),
  ),
  writable: Schema.Boolean,
});
export type Param = Schema.Schema.Type<typeof Param>;

export const LogLine = Schema.Struct({
  at: Schema.Number,
  level: Schema.Literals(["debug", "info", "warning", "error"]),
  message: Schema.String,
  unitName: Schema.optional(Schema.String),
  unitKind: Schema.optional(Schema.String),
});
export type LogLine = Schema.Schema.Type<typeof LogLine>;

export const ProjectEvent = Schema.Struct({
  at: Schema.Number,
  event: Schema.String,
  unitName: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProjectEvent = Schema.Schema.Type<typeof ProjectEvent>;

export const TimerSummary = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  pending: Schema.Number,
  fired: Schema.Number,
});
export type TimerSummary = Schema.Schema.Type<typeof TimerSummary>;

export const WorkflowRunSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
});
export type WorkflowRunSummary = Schema.Schema.Type<typeof WorkflowRunSummary>;

/**
 * Service-handled metadata API. It is merged with the project API by the
 * artifact client but served on a separate gateway path so the service can
 * answer it without a worker round trip.
 */
export const ArtifactMetadata = RpcGroup.make(
  Rpc.make("Project", { success: ProjectInfo }),
  Rpc.make("Units", { success: Schema.Array(Unit) }),
  Rpc.make("Params", { success: Schema.Array(Param) }),
  Rpc.make("Logs", {
    payload: {
      unit: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Number),
    },
    stream: true,
    success: LogLine,
  }),
  Rpc.make("Events", {
    payload: {
      unit: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    },
    stream: true,
    success: ProjectEvent,
  }),
  /** Read-only durable history for one subscription, newest first. */
  Rpc.make("EventHistory", {
    payload: {
      subscription: Schema.String,
      limit: Schema.optional(Schema.Number),
      before: Schema.optional(Schema.String),
    },
    success: Schema.Struct({
      subscription: Schema.String,
      entries: Schema.Array(
        Schema.Struct({
          cursor: Schema.String,
          receivedAt: Schema.Number,
          fingerprint: Schema.String,
          event: Schema.Unknown,
        }),
      ),
    }),
  }),
  Rpc.make("Timers", { success: Schema.Array(TimerSummary) }),
  Rpc.make("Workflows", { success: Schema.Array(WorkflowRunSummary) }),
  Rpc.make("SetParam", {
    payload: { key: Schema.String, value: ParamValue },
    success: Schema.Void,
  }).annotate(ArtifactAction, true),
  Rpc.make("CancelTimer", {
    payload: { name: Schema.String, key: Schema.String },
    success: Schema.Boolean,
  }).annotate(ArtifactAction, true),
);

export type ArtifactMetadataRpcs = RpcGroup.Rpcs<typeof ArtifactMetadata>;
