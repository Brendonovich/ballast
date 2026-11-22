import { Schema } from "effect";

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
 * Everything planning a script discovers before it runs. This is the exact
 * shape in docs/HANDOFF.md §6 Step 3.
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
  (topic.condition === undefined ? "" : `#${topicConditionKey(topic.condition)}`);

export const requestManifestKey = (request: RequestManifest): string =>
  `${request.integration}/${request.slot}/${request.request}`;
