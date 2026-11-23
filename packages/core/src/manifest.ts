import * as Effect from "effect/Effect";
import { Schema } from "effect";

export const SourceLocationSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
});
export type SourceLocation = Schema.Schema.Type<typeof SourceLocationSchema>;

export const ParamTypeSchema = Schema.Literals(["string", "number", "boolean", "enum"]);
export type ParamType = Schema.Schema.Type<typeof ParamTypeSchema>;

export const ParamOptionSourceSchema = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  source: Schema.String,
});
export type ParamOptionSource = Schema.Schema.Type<typeof ParamOptionSourceSchema>;

export const ParamDefaultSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type ParamDefault = Schema.Schema.Type<typeof ParamDefaultSchema>;

export const ParamManifestSchema = Schema.Struct({
  key: Schema.String,
  type: ParamTypeSchema,
  source: Schema.optional(SourceLocationSchema),
  title: Schema.optional(Schema.String),
  default: Schema.optional(ParamDefaultSchema),
  options: Schema.optional(ParamOptionSourceSchema),
});
export type ParamManifest = Schema.Schema.Type<typeof ParamManifestSchema>;

export const ConnectionLocationSchema = Schema.Literals(["local", "cloud", "either"]);
export type ConnectionLocation = Schema.Schema.Type<typeof ConnectionLocationSchema>;

export const ConnectionManifestSchema = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  location: ConnectionLocationSchema,
});
export type ConnectionManifest = Schema.Schema.Type<typeof ConnectionManifestSchema>;

export const OnStaleSchema = Schema.Literals(["drop", "deliver"]);
export type OnStale = Schema.Schema.Type<typeof OnStaleSchema>;

/**
 * A transport-specific subscription condition value.
 *
 * A literal string is sent to the provider as-is (for example an EventSub
 * `reward_id`). `{ slot }` refers to the identity of another connection slot
 * from the same integration; the agent resolves it (for Twitch, to the
 * account's user id) when it creates the subscription.
 */
export const TopicConditionValueSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ slot: Schema.String }),
]);
export type TopicConditionValue = Schema.Schema.Type<typeof TopicConditionValueSchema>;

export const TopicConditionSchema = Schema.Record(
  Schema.String,
  TopicConditionValueSchema,
);
export type TopicCondition = Schema.Schema.Type<typeof TopicConditionSchema>;

export const TopicManifestSchema = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  topic: Schema.String,
  /** Optional stable subscription name; required by the project-bundle API. */
  name: Schema.optional(Schema.String),
  source: Schema.optional(SourceLocationSchema),
  scopes: Schema.Array(Schema.String),
  onStale: OnStaleSchema,
  maxAgeMs: Schema.Number,
  /**
   * Extra parameters the transport needs to create the subscription, such as
   * Twitch EventSub conditions. Values that depend on the account identity use
   * `{ slot }` instead of a user id, so planning never needs a live account.
   */
  condition: Schema.optional(TopicConditionSchema),
});
export type TopicManifest = Schema.Schema.Type<typeof TopicManifestSchema>;

export const RequestManifestSchema = Schema.Struct({
  integration: Schema.String,
  slot: Schema.String,
  request: Schema.String,
  scopes: Schema.Array(Schema.String),
});
export type RequestManifest = Schema.Schema.Type<typeof RequestManifestSchema>;

export const UnresolvedManifestSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
});
export type UnresolvedManifest = Schema.Schema.Type<typeof UnresolvedManifestSchema>;

/**
 * A durable timer declaration. Timers are script-local: the payload is
 * persisted with the timer and delivered back to the script when it fires.
 *
 * `payloadSchema` is the JSON Schema document derived from the payload codec,
 * and `payloadFingerprint` is a stable hash of it. The host compares the
 * fingerprint with the manifest that scheduled a durable timer before firing
 * it, so a schema change between sleep and wake is detected instead of being
 * decoded as a different shape.
 */
export const TimerManifestSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.optional(SourceLocationSchema),
  title: Schema.optional(Schema.String),
  onStale: OnStaleSchema,
  maxAgeMs: Schema.Number,
  payloadSchema: Schema.Unknown,
  payloadFingerprint: Schema.String,
});
export type TimerManifest = Schema.Schema.Type<typeof TimerManifestSchema>;

/**
 * A workflow declared in init. Activities are intentionally not here: they are
 * inline Effect values created by the workflow body, so planning cannot know
 * them (see decision 0007). The engine journals activity names and schema
 * hashes at runtime instead.
 */
export const WorkflowManifestSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.optional(SourceLocationSchema),
  title: Schema.optional(Schema.String),
  payloadSchema: Schema.Unknown,
  successSchema: Schema.Unknown,
  errorSchema: Schema.Unknown,
  fingerprint: Schema.String,
});
export type WorkflowManifest = Schema.Schema.Type<typeof WorkflowManifestSchema>;

/**
 * Everything planning a script discovers before it runs. This is the exact
 * shape in docs/HANDOFF.md §6 Step 3, plus the additive `timers` field from
 * decision 0006 and `workflows` from decision 0007.
 */
export const ManifestSchema = Schema.Struct({
  script: Schema.Struct({
    id: Schema.String,
  }),
  params: Schema.Array(ParamManifestSchema),
  connections: Schema.Array(ConnectionManifestSchema),
  topics: Schema.Array(TopicManifestSchema),
  requests: Schema.Array(RequestManifestSchema),
  unresolved: Schema.Array(UnresolvedManifestSchema),
  timers: Schema.Array(TimerManifestSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workflows: Schema.Array(WorkflowManifestSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type Manifest = Schema.Schema.Type<typeof ManifestSchema>;

/** The schema, exported under the manifest's name for hosts that validate input. */
export const Manifest = ManifestSchema;

export const emptyManifest = (scriptId: string): Manifest => ({
  script: { id: scriptId },
  params: [],
  connections: [],
  topics: [],
  requests: [],
  unresolved: [],
  timers: [],
  workflows: [],
});

export const connectionKey = (connection: ConnectionManifest): string =>
  `${connection.integration}/${connection.slot}`;

const topicConditionKey = (condition: TopicCondition): string =>
  JSON.stringify(
    Object.keys(condition)
      .sort()
      .map((key) => [key, condition[key]]),
  );

export const topicManifestKey = (topic: TopicManifest): string =>
  `${topic.integration}/${topic.slot}/${topic.topic}` +
  (topic.name === undefined ? "" : `#name:${topic.name}`) +
  (topic.condition === undefined ? "" : `#${topicConditionKey(topic.condition)}`);

export const requestManifestKey = (request: RequestManifest): string =>
  `${request.integration}/${request.slot}/${request.request}`;

export const timerManifestKey = (timer: TimerManifest): string => timer.name;

export const workflowManifestKey = (workflow: WorkflowManifest): string => workflow.name;
