import { Schema } from "effect";

import { WebhookRelayDelivery } from "./webhooks.ts";

/**
 * The common event envelope for everything the cloud relays to an agent.
 *
 * - `id` is stable across provider retries (for Twitch it is the EventSub
 *   message id), so the agent can drop duplicates.
 * - `topic` is the integration's typed topic key, e.g. `twitch/channel.cheer`.
 * - `connectionId` is the cloud-side connection id (a Twitch account id).
 * - Ordering is per `(connectionId, topic)`, established by the relay's
 *   monotonically increasing `seq` (see {@link RelayServerMessage}).
 */
export const EventEnvelope = Schema.Struct({
  id: Schema.String,
  integration: Schema.String,
  topic: Schema.String,
  connectionId: Schema.String,
  occurredAt: Schema.Number,
  receivedAt: Schema.Number,
  payload: Schema.Json,
  /** What the relay does with an event that is older than `maxAgeMs`. */
  onStale: Schema.Literals(["drop", "deliver"]),
  /** How fresh an event must be to be delivered while connected, in ms. */
  maxAgeMs: Schema.Number,
});
export type EventEnvelope = typeof EventEnvelope.Type;

export const DEFAULT_MAX_AGE_MS = 60_000;
/** How long the relay keeps events for reconnect, replay and the inspector. */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Upper bound on buffered events per machine; oldest events are evicted. */
export const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;

export const twitchTopic = (subscriptionType: string) => `twitch/${subscriptionType}`;

export const makeEventEnvelope = (input: {
  readonly id: string;
  readonly integration: string;
  readonly topic: string;
  readonly connectionId: string;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly payload: Schema.Json;
  readonly onStale?: EventEnvelope["onStale"];
  readonly maxAgeMs?: number;
}): EventEnvelope => ({
  id: input.id,
  integration: input.integration,
  topic: input.topic,
  connectionId: input.connectionId,
  occurredAt: input.occurredAt,
  receivedAt: input.receivedAt,
  payload: input.payload,
  onStale: input.onStale ?? "drop",
  maxAgeMs: input.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
});

/**
 * The messages the relay sends to a connected agent.
 *
 * `event.seq` is the ack unit and is assigned by the relay. `stale` is set
 * when an event was buffered past its `maxAgeMs` and the subscription chose
 * `onStale: "deliver"`.
 */
export const RelayServerMessage = Schema.Union([
  Schema.TaggedStruct("hello", {
    machineId: Schema.String,
    serverTime: Schema.Number,
    pending: Schema.Number,
  }),
  Schema.TaggedStruct("event", {
    seq: Schema.Number,
    envelope: EventEnvelope,
    stale: Schema.Boolean,
  }),
  Schema.TaggedStruct("subscription_revoked", {
    connectionId: Schema.String,
    subscriptionType: Schema.String,
    providerSubscriptionId: Schema.String,
    revokedAt: Schema.Number,
  }),
  Schema.TaggedStruct("webhook_delivery", {
    seq: Schema.Number,
    stale: Schema.Boolean,
    delivery: WebhookRelayDelivery,
  }),
  Schema.TaggedStruct("ping", {
    at: Schema.Number,
  }),
  /**
   * A share this machine subscribes to has a new deploy. Not buffered:
   * agents also poll their subscriptions after (re)connecting.
   */
  Schema.TaggedStruct("share_update", {
    shareId: Schema.String,
    sha: Schema.String,
    message: Schema.NullOr(Schema.String),
    deployedAt: Schema.Number,
  }),
]);
export type RelayServerMessage = typeof RelayServerMessage.Type;

/** The messages an agent sends to the relay over its WebSocket. */
export const RelayClientMessage = Schema.Union([
  Schema.TaggedStruct("ack", {
    seqs: Schema.Array(Schema.Number),
  }),
  Schema.TaggedStruct("pong", {
    at: Schema.Number,
  }),
]);
export type RelayClientMessage = typeof RelayClientMessage.Type;

export const encodeRelayServerMessage = Schema.encodeSync(
  Schema.fromJsonString(RelayServerMessage),
);
export const decodeRelayClientMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayClientMessage),
);

export const encodeRelayClientMessage = Schema.encodeSync(
  Schema.fromJsonString(RelayClientMessage),
);
