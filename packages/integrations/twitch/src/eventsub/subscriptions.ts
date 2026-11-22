import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { topicKey } from "../protocol/topic.ts";
import type { TwitchTopicKey } from "../protocol/topic.ts";
import {
  ChannelPointsRedemptionAddPayload,
  ChatMessagePayload,
  CheerPayload,
  FollowPayload,
  RaidPayload,
  StreamOfflinePayload,
  StreamOnlinePayload,
  SubscribePayload,
} from "./schemas.ts";

export type ConditionRecord = Readonly<Record<string, string>>;

export interface SubscriptionEventFor<Type extends string, Payload> {
  readonly type: Type;
  /** Ballast topic key: `twitch/<subscription type>`. */
  readonly topic: TwitchTopicKey<Type>;
  readonly payload: Payload;
}

export type SubscriptionEvent = {
  [K in keyof typeof subscriptions]: SubscriptionEventFor<K, PayloadOf<K>>;
}[keyof typeof subscriptions];

export interface SubscriptionDefinition<
  Name extends string,
  Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
> {
  /** Friendly export name for the script-facing topic object. */
  readonly name: Name;
  readonly type: Type;
  readonly version: number;
  readonly condition: Schema.Codec<Condition, unknown, never, never>;
  /** Scopes that authorize this subscription. Empty means no scope is required. */
  readonly scopes: ReadonlyArray<string>;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  readonly docsUrl: string;
  readonly decode: (payload: unknown) => Effect.Effect<SubscriptionEventFor<Type, Payload>, Schema.SchemaError>;
}

const docsUrl = (anchor: string) =>
  `https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#${anchor}`;

const defineSubscription = <
  const Name extends string,
  const Type extends string,
  Condition extends Readonly<Record<string, string | undefined>>,
  Payload,
>(config: {
  readonly name: Name;
  readonly type: Type;
  readonly version: number;
  readonly condition: Schema.Codec<Condition, unknown, never, never>;
  readonly scopes: ReadonlyArray<string>;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  readonly docsUrl: string;
}): SubscriptionDefinition<Name, Type, Condition, Payload> => ({
  name: config.name,
  type: config.type,
  version: config.version,
  condition: config.condition,
  scopes: config.scopes,
  payload: config.payload,
  docsUrl: config.docsUrl,
  decode: (payload) =>
    Effect.map(Schema.decodeUnknownEffect(config.payload)(payload), (event) => ({
      type: config.type,
      topic: topicKey(config.type),
      payload: event,
    })),
});

const RaidCondition = Schema.Struct({
  from_broadcaster_user_id: Schema.optional(Schema.String),
  to_broadcaster_user_id: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(
    (condition) =>
      (condition.from_broadcaster_user_id === undefined) !==
        (condition.to_broadcaster_user_id === undefined) ||
      "set exactly one of from_broadcaster_user_id or to_broadcaster_user_id",
    { message: "set exactly one of from_broadcaster_user_id or to_broadcaster_user_id" },
  ),
);

/**
 * The subscription types Ballast uses first. Each entry is complete data:
 * friendly name, Twitch type, version, condition schema, required scopes,
 * payload schema, and a decoder. Script-facing topic objects can be generated
 * from these without duplicating protocol knowledge.
 */
export const subscriptions = {
  "channel.channel_points_custom_reward_redemption.add": defineSubscription({
    name: "ChannelPointsRedemption",
    type: "channel.channel_points_custom_reward_redemption.add",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      reward_id: Schema.optional(Schema.String),
    }),
    scopes: ["channel:read:redemptions"],
    payload: ChannelPointsRedemptionAddPayload,
    docsUrl: docsUrl("channelchannel_points_custom_reward_redemptionadd"),
  }),
  "channel.chat.message": defineSubscription({
    name: "ChatMessage",
    type: "channel.chat.message",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      user_id: Schema.String,
    }),
    scopes: ["user:read:chat"],
    payload: ChatMessagePayload,
    docsUrl: docsUrl("channelchatmessage"),
  }),
  "channel.follow": defineSubscription({
    name: "Follow",
    type: "channel.follow",
    version: 2,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      moderator_user_id: Schema.String,
    }),
    scopes: ["moderator:read:followers"],
    payload: FollowPayload,
    docsUrl: docsUrl("channelfollow"),
  }),
  "channel.subscribe": defineSubscription({
    name: "Subscribe",
    type: "channel.subscribe",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:subscriptions"],
    payload: SubscribePayload,
    docsUrl: docsUrl("channelsubscribe"),
  }),
  "channel.cheer": defineSubscription({
    name: "Cheer",
    type: "channel.cheer",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["bits:read"],
    payload: CheerPayload,
    docsUrl: docsUrl("channelcheer"),
  }),
  "channel.raid": defineSubscription({
    name: "Raid",
    type: "channel.raid",
    version: 1,
    condition: RaidCondition,
    scopes: [],
    payload: RaidPayload,
    docsUrl: docsUrl("channelraid"),
  }),
  "stream.online": defineSubscription({
    name: "StreamOnline",
    type: "stream.online",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: [],
    payload: StreamOnlinePayload,
    docsUrl: docsUrl("streamonline"),
  }),
  "stream.offline": defineSubscription({
    name: "StreamOffline",
    type: "stream.offline",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: [],
    payload: StreamOfflinePayload,
    docsUrl: docsUrl("streamoffline"),
  }),
} as const;

export type SubscriptionType = keyof typeof subscriptions;
export type SubscriptionDefinitionFor<K extends SubscriptionType> = (typeof subscriptions)[K];
export type ConditionOf<K extends SubscriptionType> = Schema.Schema.Type<
  SubscriptionDefinitionFor<K>["condition"]
>;
export type PayloadOf<K extends SubscriptionType> = Schema.Schema.Type<
  SubscriptionDefinitionFor<K>["payload"]
>;
export type NotificationFor<K extends SubscriptionType> = SubscriptionEventFor<K, PayloadOf<K>> & {
  readonly version: number;
};

/** Every typed notification, discriminated by `type`. */
export type SubscriptionNotification = {
  [K in SubscriptionType]: NotificationFor<K>;
}[SubscriptionType];

/** Topic key → definition, the shape the manifest and inspector consume. */
export const catalog = {
  [topicKey("channel.channel_points_custom_reward_redemption.add")]:
    subscriptions["channel.channel_points_custom_reward_redemption.add"],
  [topicKey("channel.chat.message")]: subscriptions["channel.chat.message"],
  [topicKey("channel.follow")]: subscriptions["channel.follow"],
  [topicKey("channel.subscribe")]: subscriptions["channel.subscribe"],
  [topicKey("channel.cheer")]: subscriptions["channel.cheer"],
  [topicKey("channel.raid")]: subscriptions["channel.raid"],
  [topicKey("stream.online")]: subscriptions["stream.online"],
  [topicKey("stream.offline")]: subscriptions["stream.offline"],
} as const;

/** Friendly name → definition, for generating namespace-level topic objects. */
export const topics = {
  ChannelPointsRedemption: subscriptions["channel.channel_points_custom_reward_redemption.add"],
  ChatMessage: subscriptions["channel.chat.message"],
  Follow: subscriptions["channel.follow"],
  Subscribe: subscriptions["channel.subscribe"],
  Cheer: subscriptions["channel.cheer"],
  Raid: subscriptions["channel.raid"],
  StreamOnline: subscriptions["stream.online"],
  StreamOffline: subscriptions["stream.offline"],
} as const;

export type TopicName = keyof typeof topics;

export const isSubscriptionType = (value: string): value is SubscriptionType =>
  Object.hasOwn(subscriptions, value);

export class UnknownSubscriptionType extends Schema.TaggedError<UnknownSubscriptionType>()(
  "UnknownSubscriptionType",
  { type: Schema.String },
) {}

const decoders: Record<
  SubscriptionType,
  (payload: unknown) => Effect.Effect<SubscriptionEvent, Schema.SchemaError>
> = {
  "channel.channel_points_custom_reward_redemption.add":
    subscriptions["channel.channel_points_custom_reward_redemption.add"].decode,
  "channel.chat.message": subscriptions["channel.chat.message"].decode,
  "channel.follow": subscriptions["channel.follow"].decode,
  "channel.subscribe": subscriptions["channel.subscribe"].decode,
  "channel.cheer": subscriptions["channel.cheer"].decode,
  "channel.raid": subscriptions["channel.raid"].decode,
  "stream.online": subscriptions["stream.online"].decode,
  "stream.offline": subscriptions["stream.offline"].decode,
};

/** Decode an event payload by its Twitch subscription type. */
export const decodeSubscriptionEvent = (
  type: string,
  payload: unknown,
): Effect.Effect<SubscriptionEvent, Schema.SchemaError | UnknownSubscriptionType> =>
  isSubscriptionType(type)
    ? decoders[type](payload)
    : Effect.fail(new UnknownSubscriptionType({ type }));

const toConditionRecord = (condition: unknown): ConditionRecord => {
  if (typeof condition !== "object" || condition === null) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(condition)) {
    if (typeof value === "string") entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

/**
 * Validate a condition against its subscription type and drop unset optional
 * keys, producing the flat string record Twitch expects.
 */
export const buildCondition = <K extends SubscriptionType>(
  type: K,
  condition: ConditionOf<K>,
): ConditionRecord => {
  const definition: Schema.Codec<unknown, unknown, never, never> = subscriptions[type].condition;
  return toConditionRecord(Schema.encodeSync(definition)(condition));
};

/** A subscription to create for a new EventSub WebSocket session. */
export interface SubscriptionRequest {
  readonly type: SubscriptionType;
  readonly version: number;
  readonly condition: ConditionRecord;
}

export const subscriptionRequest = <K extends SubscriptionType>(
  type: K,
  condition: ConditionOf<K>,
): SubscriptionRequest => ({
  type,
  version: subscriptions[type].version,
  condition: buildCondition(type, condition),
});
