import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { topicKey } from "../protocol/topic.ts";
import type { TwitchTopicKey } from "../protocol/topic.ts";
import {
  ChannelPointsRedemptionPayload,
  ChannelUpdatePayload,
  ChatMessagePayload,
  CheerPayload,
  CustomRewardEventPayload,
  FollowPayload,
  HypeTrainBeginPayload,
  HypeTrainEndPayload,
  HypeTrainProgressPayload,
  PollBeginPayload,
  PollEndPayload,
  PollProgressPayload,
  PredictionBeginPayload,
  PredictionEndPayload,
  PredictionLockPayload,
  PredictionProgressPayload,
  RaidPayload,
  StreamOfflinePayload,
  StreamOnlinePayload,
  SubscribePayload,
  SubscriptionEndPayload,
  SubscriptionGiftPayload,
  SubscriptionMessagePayload,
} from "./schemas.ts";

export type ConditionRecord = Readonly<Record<string, string>>;

/**
 * How a condition field identifies a user:
 * - `self` must be the connection's own Twitch user (whose token authorizes).
 * - `target` is another channel/account (broadcaster or moderator target).
 * - `any` is an opaque filter such as `reward_id`.
 */
export type ConditionRole = "self" | "target" | "any";

/**
 * For `target` fields, whether Twitch accepts any channel or only a channel
 * linked to the same Ballast user. Twitch itself enforces moderator/read
 * permissions; the cloud only guards account ownership.
 */
export type TargetPolicy = "linked-or-any" | "linked-only";

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
  /** Twitch's EventSub cost for this subscription type (1 unless documented otherwise). */
  readonly cost: number;
  /** How each condition field identifies a user, for cross-account validation. */
  readonly conditionRoles: Readonly<Record<string, ConditionRole>>;
  /** Applies to `target` fields; omitted when the type has no target fields. */
  readonly targetPolicy?: TargetPolicy;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  readonly docsUrl: string;
  readonly decode: (payload: unknown) => Effect.Effect<SubscriptionEventFor<Type, Payload>, Schema.SchemaError>;
}

const docsUrl = (page: string, anchor: string) =>
  `https://dev.twitch.tv/docs/eventsub/reference/${page}/#${anchor}`;

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
  readonly cost: number;
  readonly conditionRoles: Readonly<Record<string, ConditionRole>>;
  readonly targetPolicy?: TargetPolicy;
  readonly payload: Schema.Codec<Payload, unknown, never, never>;
  readonly docsUrl: string;
}): SubscriptionDefinition<Name, Type, Condition, Payload> => ({
  name: config.name,
  type: config.type,
  version: config.version,
  condition: config.condition,
  scopes: config.scopes,
  cost: config.cost,
  conditionRoles: config.conditionRoles,
  ...(config.targetPolicy === undefined ? {} : { targetPolicy: config.targetPolicy }),
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
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self", reward_id: "any" },
    payload: ChannelPointsRedemptionPayload,
    docsUrl: docsUrl("channel-points", "channel-channel-points-custom-reward-redemption-add"),
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
    cost: 1,
    conditionRoles: { broadcaster_user_id: "target", user_id: "self" },
    targetPolicy: "linked-or-any",
    payload: ChatMessagePayload,
    docsUrl: docsUrl("chat", "channel-chat-message"),
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
    cost: 1,
    conditionRoles: { broadcaster_user_id: "target", moderator_user_id: "self" },
    targetPolicy: "linked-or-any",
    payload: FollowPayload,
    docsUrl: docsUrl("channel", "channel-follow"),
  }),
  "channel.subscribe": defineSubscription({
    name: "Subscribe",
    type: "channel.subscribe",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:subscriptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: SubscribePayload,
    docsUrl: docsUrl("channel", "channel-subscribe"),
  }),
  "channel.cheer": defineSubscription({
    name: "Cheer",
    type: "channel.cheer",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["bits:read"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: CheerPayload,
    docsUrl: docsUrl("channel", "channel-cheer"),
  }),
  "channel.raid": defineSubscription({
    name: "Raid",
    type: "channel.raid",
    version: 1,
    condition: RaidCondition,
    scopes: [],
    cost: 1,
    conditionRoles: {
      from_broadcaster_user_id: "self",
      to_broadcaster_user_id: "self",
    },
    payload: RaidPayload,
    docsUrl: docsUrl("channel", "channel-raid"),
  }),
  "stream.online": defineSubscription({
    name: "StreamOnline",
    type: "stream.online",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: [],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: StreamOnlinePayload,
    docsUrl: docsUrl("stream", "stream-online"),
  }),
  "stream.offline": defineSubscription({
    name: "StreamOffline",
    type: "stream.offline",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: [],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: StreamOfflinePayload,
    docsUrl: docsUrl("stream", "stream-offline"),
  }),
  "channel.channel_points_custom_reward_redemption.update": defineSubscription({
    name: "ChannelPointsRedemptionUpdate",
    type: "channel.channel_points_custom_reward_redemption.update",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      reward_id: Schema.optional(Schema.String),
    }),
    scopes: ["channel:read:redemptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self", reward_id: "any" },
    payload: ChannelPointsRedemptionPayload,
    docsUrl: docsUrl(
      "channel-points",
      "channel-channel-points-custom-reward-redemption-update",
    ),
  }),
  "channel.channel_points_custom_reward.add": defineSubscription({
    name: "CustomRewardAdd",
    type: "channel.channel_points_custom_reward.add",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:redemptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: CustomRewardEventPayload,
    docsUrl: docsUrl("channel-points", "channel-channel-points-custom-reward-add"),
  }),
  "channel.channel_points_custom_reward.update": defineSubscription({
    name: "CustomRewardUpdate",
    type: "channel.channel_points_custom_reward.update",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      reward_id: Schema.optional(Schema.String),
    }),
    scopes: ["channel:read:redemptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self", reward_id: "any" },
    payload: CustomRewardEventPayload,
    docsUrl: docsUrl("channel-points", "channel-channel-points-custom-reward-update"),
  }),
  "channel.channel_points_custom_reward.remove": defineSubscription({
    name: "CustomRewardRemove",
    type: "channel.channel_points_custom_reward.remove",
    version: 1,
    condition: Schema.Struct({
      broadcaster_user_id: Schema.String,
      reward_id: Schema.optional(Schema.String),
    }),
    scopes: ["channel:read:redemptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self", reward_id: "any" },
    payload: CustomRewardEventPayload,
    docsUrl: docsUrl("channel-points", "channel-channel-points-custom-reward-remove"),
  }),
  "channel.hype_train.begin": defineSubscription({
    name: "HypeTrainBegin",
    type: "channel.hype_train.begin",
    version: 2,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:hype_train"],
    cost: 2,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: HypeTrainBeginPayload,
    docsUrl: docsUrl("hype-train", "channel-hype-train-begin"),
  }),
  "channel.hype_train.progress": defineSubscription({
    name: "HypeTrainProgress",
    type: "channel.hype_train.progress",
    version: 2,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:hype_train"],
    cost: 2,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: HypeTrainProgressPayload,
    docsUrl: docsUrl("hype-train", "channel-hype-train-progress"),
  }),
  "channel.hype_train.end": defineSubscription({
    name: "HypeTrainEnd",
    type: "channel.hype_train.end",
    version: 2,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:hype_train"],
    cost: 2,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: HypeTrainEndPayload,
    docsUrl: docsUrl("hype-train", "channel-hype-train-end"),
  }),
  "channel.poll.begin": defineSubscription({
    name: "PollBegin",
    type: "channel.poll.begin",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:polls"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PollBeginPayload,
    docsUrl: docsUrl("poll", "channel-poll-begin"),
  }),
  "channel.poll.progress": defineSubscription({
    name: "PollProgress",
    type: "channel.poll.progress",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:polls"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PollProgressPayload,
    docsUrl: docsUrl("poll", "channel-poll-progress"),
  }),
  "channel.poll.end": defineSubscription({
    name: "PollEnd",
    type: "channel.poll.end",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:polls"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PollEndPayload,
    docsUrl: docsUrl("poll", "channel-poll-end"),
  }),
  "channel.prediction.begin": defineSubscription({
    name: "PredictionBegin",
    type: "channel.prediction.begin",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:predictions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PredictionBeginPayload,
    docsUrl: docsUrl("prediction", "channel-prediction-begin"),
  }),
  "channel.prediction.progress": defineSubscription({
    name: "PredictionProgress",
    type: "channel.prediction.progress",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:predictions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PredictionProgressPayload,
    docsUrl: docsUrl("prediction", "channel-prediction-progress"),
  }),
  "channel.prediction.lock": defineSubscription({
    name: "PredictionLock",
    type: "channel.prediction.lock",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:predictions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PredictionLockPayload,
    docsUrl: docsUrl("prediction", "channel-prediction-lock"),
  }),
  "channel.prediction.end": defineSubscription({
    name: "PredictionEnd",
    type: "channel.prediction.end",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:predictions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: PredictionEndPayload,
    docsUrl: docsUrl("prediction", "channel-prediction-end"),
  }),
  "channel.update": defineSubscription({
    name: "ChannelUpdate",
    type: "channel.update",
    version: 2,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: [],
    cost: 2,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: ChannelUpdatePayload,
    docsUrl: docsUrl("channel", "channel-update"),
  }),
  "channel.subscription.gift": defineSubscription({
    name: "SubscriptionGift",
    type: "channel.subscription.gift",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:subscriptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: SubscriptionGiftPayload,
    docsUrl: docsUrl("channel", "channel-subscription-gift"),
  }),
  "channel.subscription.message": defineSubscription({
    name: "SubscriptionMessage",
    type: "channel.subscription.message",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:subscriptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: SubscriptionMessagePayload,
    docsUrl: docsUrl("channel", "channel-subscription-message"),
  }),
  "channel.subscription.end": defineSubscription({
    name: "SubscriptionEnd",
    type: "channel.subscription.end",
    version: 1,
    condition: Schema.Struct({ broadcaster_user_id: Schema.String }),
    scopes: ["channel:read:subscriptions"],
    cost: 1,
    conditionRoles: { broadcaster_user_id: "self" },
    payload: SubscriptionEndPayload,
    docsUrl: docsUrl("channel", "channel-subscription-end"),
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
  [topicKey("channel.channel_points_custom_reward_redemption.update")]:
    subscriptions["channel.channel_points_custom_reward_redemption.update"],
  [topicKey("channel.channel_points_custom_reward.add")]:
    subscriptions["channel.channel_points_custom_reward.add"],
  [topicKey("channel.channel_points_custom_reward.update")]:
    subscriptions["channel.channel_points_custom_reward.update"],
  [topicKey("channel.channel_points_custom_reward.remove")]:
    subscriptions["channel.channel_points_custom_reward.remove"],
  [topicKey("channel.chat.message")]: subscriptions["channel.chat.message"],
  [topicKey("channel.follow")]: subscriptions["channel.follow"],
  [topicKey("channel.subscribe")]: subscriptions["channel.subscribe"],
  [topicKey("channel.subscription.gift")]: subscriptions["channel.subscription.gift"],
  [topicKey("channel.subscription.message")]: subscriptions["channel.subscription.message"],
  [topicKey("channel.subscription.end")]: subscriptions["channel.subscription.end"],
  [topicKey("channel.cheer")]: subscriptions["channel.cheer"],
  [topicKey("channel.raid")]: subscriptions["channel.raid"],
  [topicKey("channel.hype_train.begin")]: subscriptions["channel.hype_train.begin"],
  [topicKey("channel.hype_train.progress")]: subscriptions["channel.hype_train.progress"],
  [topicKey("channel.hype_train.end")]: subscriptions["channel.hype_train.end"],
  [topicKey("channel.poll.begin")]: subscriptions["channel.poll.begin"],
  [topicKey("channel.poll.progress")]: subscriptions["channel.poll.progress"],
  [topicKey("channel.poll.end")]: subscriptions["channel.poll.end"],
  [topicKey("channel.prediction.begin")]: subscriptions["channel.prediction.begin"],
  [topicKey("channel.prediction.progress")]: subscriptions["channel.prediction.progress"],
  [topicKey("channel.prediction.lock")]: subscriptions["channel.prediction.lock"],
  [topicKey("channel.prediction.end")]: subscriptions["channel.prediction.end"],
  [topicKey("channel.update")]: subscriptions["channel.update"],
  [topicKey("stream.online")]: subscriptions["stream.online"],
  [topicKey("stream.offline")]: subscriptions["stream.offline"],
} as const;

/** Friendly name → definition, for generating namespace-level topic objects. */
export const topics = {
  ChannelPointsRedemption: subscriptions["channel.channel_points_custom_reward_redemption.add"],
  ChannelPointsRedemptionUpdate:
    subscriptions["channel.channel_points_custom_reward_redemption.update"],
  CustomRewardAdd: subscriptions["channel.channel_points_custom_reward.add"],
  CustomRewardUpdate: subscriptions["channel.channel_points_custom_reward.update"],
  CustomRewardRemove: subscriptions["channel.channel_points_custom_reward.remove"],
  ChatMessage: subscriptions["channel.chat.message"],
  Follow: subscriptions["channel.follow"],
  Subscribe: subscriptions["channel.subscribe"],
  SubscriptionGift: subscriptions["channel.subscription.gift"],
  SubscriptionMessage: subscriptions["channel.subscription.message"],
  SubscriptionEnd: subscriptions["channel.subscription.end"],
  Cheer: subscriptions["channel.cheer"],
  Raid: subscriptions["channel.raid"],
  HypeTrainBegin: subscriptions["channel.hype_train.begin"],
  HypeTrainProgress: subscriptions["channel.hype_train.progress"],
  HypeTrainEnd: subscriptions["channel.hype_train.end"],
  PollBegin: subscriptions["channel.poll.begin"],
  PollProgress: subscriptions["channel.poll.progress"],
  PollEnd: subscriptions["channel.poll.end"],
  PredictionBegin: subscriptions["channel.prediction.begin"],
  PredictionProgress: subscriptions["channel.prediction.progress"],
  PredictionLock: subscriptions["channel.prediction.lock"],
  PredictionEnd: subscriptions["channel.prediction.end"],
  ChannelUpdate: subscriptions["channel.update"],
  StreamOnline: subscriptions["stream.online"],
  StreamOffline: subscriptions["stream.offline"],
} as const;

export type TopicName = keyof typeof topics;

export const isSubscriptionType = (value: string): value is SubscriptionType =>
  Object.hasOwn(subscriptions, value);

/** Twitch's published cost for a known type; unknown types default to 1. */
export const subscriptionCost = (type: string): number =>
  isSubscriptionType(type) ? subscriptions[type].cost : 1;

export class UnknownSubscriptionType extends Schema.TaggedError<UnknownSubscriptionType>()(
  "UnknownSubscriptionType",
  { type: Schema.String },
) {}

export const payloadDecoders: Record<
  SubscriptionType,
  (payload: unknown) => Effect.Effect<SubscriptionEvent, Schema.SchemaError>
> = {
  "channel.channel_points_custom_reward_redemption.add":
    subscriptions["channel.channel_points_custom_reward_redemption.add"].decode,
  "channel.channel_points_custom_reward_redemption.update":
    subscriptions["channel.channel_points_custom_reward_redemption.update"].decode,
  "channel.channel_points_custom_reward.add":
    subscriptions["channel.channel_points_custom_reward.add"].decode,
  "channel.channel_points_custom_reward.update":
    subscriptions["channel.channel_points_custom_reward.update"].decode,
  "channel.channel_points_custom_reward.remove":
    subscriptions["channel.channel_points_custom_reward.remove"].decode,
  "channel.chat.message": subscriptions["channel.chat.message"].decode,
  "channel.follow": subscriptions["channel.follow"].decode,
  "channel.subscribe": subscriptions["channel.subscribe"].decode,
  "channel.subscription.gift": subscriptions["channel.subscription.gift"].decode,
  "channel.subscription.message": subscriptions["channel.subscription.message"].decode,
  "channel.subscription.end": subscriptions["channel.subscription.end"].decode,
  "channel.cheer": subscriptions["channel.cheer"].decode,
  "channel.raid": subscriptions["channel.raid"].decode,
  "channel.hype_train.begin": subscriptions["channel.hype_train.begin"].decode,
  "channel.hype_train.progress": subscriptions["channel.hype_train.progress"].decode,
  "channel.hype_train.end": subscriptions["channel.hype_train.end"].decode,
  "channel.poll.begin": subscriptions["channel.poll.begin"].decode,
  "channel.poll.progress": subscriptions["channel.poll.progress"].decode,
  "channel.poll.end": subscriptions["channel.poll.end"].decode,
  "channel.prediction.begin": subscriptions["channel.prediction.begin"].decode,
  "channel.prediction.progress": subscriptions["channel.prediction.progress"].decode,
  "channel.prediction.lock": subscriptions["channel.prediction.lock"].decode,
  "channel.prediction.end": subscriptions["channel.prediction.end"].decode,
  "channel.update": subscriptions["channel.update"].decode,
  "stream.online": subscriptions["stream.online"].decode,
  "stream.offline": subscriptions["stream.offline"].decode,
};

/** Decode an event payload by its Twitch subscription type. */
export const decodeSubscriptionEvent = (
  type: string,
  payload: unknown,
): Effect.Effect<SubscriptionEvent, Schema.SchemaError | UnknownSubscriptionType> =>
  isSubscriptionType(type)
    ? payloadDecoders[type](payload)
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
