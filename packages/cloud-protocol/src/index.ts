import { Schema } from "effect";

export * from "./events.ts";
export * from "./http.ts";
export * from "./rpc.ts";

/** Canonical key for Twitch's unordered condition object. */
export const conditionKey = (condition: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.keys(condition)
      .sort()
      .map((key) => [key, condition[key]]),
  );

export const subscriptionKey = (input: {
  readonly type: string;
  readonly version: number;
  readonly condition: Readonly<Record<string, string>>;
}): string => JSON.stringify([input.type, input.version, conditionKey(input.condition)]);

/**
 * Twitch assigns a cost to each EventSub subscription type. The published
 * table has cost 1 for most subscriptions and cost 2 for a few
 * (channel.update, moderation/hype-train topics are 2 in the current docs).
 * Unknown types are treated as cost 1 so a new Twitch topic does not fail
 * reconciliation before the table is updated.
 */
export const TWITCH_SUBSCRIPTION_COSTS: Readonly<Record<string, number>> = {
  "channel.update": 2,
  "channel.moderate": 2,
  "channel.channel_points_automatic_reward_redemption.add": 2,
  "channel.hype_train.begin": 2,
  "channel.hype_train.progress": 2,
  "channel.hype_train.end": 2,
};

export const twitchSubscriptionCost = (type: string): number =>
  TWITCH_SUBSCRIPTION_COSTS[type] ?? 1;

/** Twitch's user-authorization EventSub cost budget for one client and user. */
export const DEFAULT_TWITCH_MAX_SUBSCRIPTION_COST = 10;

export const EventSubMessageType = Schema.Literals([
  "webhook_callback_verification",
  "notification",
  "revocation",
]);
export type EventSubMessageType = typeof EventSubMessageType.Type;

/** A Twitch EventSub webhook delivery, after signature verification. */
export const EventSubDelivery = Schema.Struct({
  challenge: Schema.optionalKey(Schema.String),
  subscription: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    type: Schema.String,
    version: Schema.String,
    condition: Schema.Record(Schema.String, Schema.String),
  }),
  event: Schema.optionalKey(Schema.Json),
});
export type EventSubDelivery = typeof EventSubDelivery.Type;

export const decodeEventSubDelivery = Schema.decodeUnknownSync(
  Schema.fromJsonString(EventSubDelivery),
);
