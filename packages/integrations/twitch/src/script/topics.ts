import * as Ballast from "@ballast/core";

import { subscriptions } from "../eventsub/subscriptions.ts";
import type { PayloadOf } from "../eventsub/subscriptions.ts";
import { INTEGRATION, topicKey } from "../protocol/topic.ts";

type Integration = typeof INTEGRATION;
const topicOf = (type: string): string => topicKey(type);
type TwitchConnection = Ballast.ConnectionRef<Integration>;

/**
 * Script-facing EventSub topics. Each object is a core `Topic`, so
 * subscribing records the topic and its OAuth scopes in the manifest and the
 * handler payload is inferred from the EventSub payload schema.
 *
 * Conditions are resolved by the agent: `{ slot }` becomes that slot's
 * Twitch user id when the transport creates the EventSub subscription. This
 * is why planning never needs a live account.
 */

const redemption = subscriptions["channel.channel_points_custom_reward_redemption.add"];

export interface ChannelPointsRedemptionOptions {
  /** Only receive redemptions of this reward, instead of the whole channel. */
  readonly rewardId?: string;
}

/**
 * `channel.channel_points_custom_reward_redemption.add` (scope
 * `channel:read:redemptions`).
 */
export const ChannelPointsRedemption = Ballast.Topic<
  PayloadOf<typeof redemption.type>,
  Integration,
  ChannelPointsRedemptionOptions
>({
  integration: INTEGRATION,
  topic: topicOf(redemption.type),
  scopes: redemption.scopes,
  schema: redemption.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: connection.slot },
    ...(options?.rewardId === undefined ? {} : { reward_id: options.rewardId }),
  }),
});

const chatMessage = subscriptions["channel.chat.message"];

export interface ChatMessageOptions {
  /**
   * The channel whose chat to read. Defaults to the subscribing account.
   * Use this with a bot account as the connection:
   * `Twitch.ChatMessage.subscribe("chat", bot, handler, { broadcaster })`.
   */
  readonly broadcaster?: TwitchConnection;
}

/**
 * `channel.chat.message` (scope `user:read:chat`). The connection is the
 * user whose token reads chat; `options.broadcaster` selects the channel.
 */
export const ChatMessage = Ballast.Topic<
  PayloadOf<typeof chatMessage.type>,
  Integration,
  ChatMessageOptions
>({
  integration: INTEGRATION,
  topic: topicOf(chatMessage.type),
  scopes: chatMessage.scopes,
  schema: chatMessage.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: (options?.broadcaster ?? connection).slot },
    user_id: { slot: connection.slot },
  }),
});

const follow = subscriptions["channel.follow"];

export interface FollowOptions {
  /**
   * The channel to watch follows for. Defaults to the subscribing account.
   * Use this with a moderator/bot account as the connection.
   */
  readonly broadcaster?: TwitchConnection;
}

/**
 * `channel.follow` v2 (scope `moderator:read:followers`). The connection
 * must be a moderator of the channel.
 */
export const Follow = Ballast.Topic<
  PayloadOf<typeof follow.type>,
  Integration,
  FollowOptions
>({
  integration: INTEGRATION,
  topic: topicOf(follow.type),
  scopes: follow.scopes,
  schema: follow.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: (options?.broadcaster ?? connection).slot },
    moderator_user_id: { slot: connection.slot },
  }),
});

const subscribe = subscriptions["channel.subscribe"];

/** `channel.subscribe` (scope `channel:read:subscriptions`). */
export const Subscribe = Ballast.Topic<PayloadOf<typeof subscribe.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(subscribe.type),
  scopes: subscribe.scopes,
  schema: subscribe.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const cheer = subscriptions["channel.cheer"];

/** `channel.cheer` (scope `bits:read`). */
export const Cheer = Ballast.Topic<PayloadOf<typeof cheer.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(cheer.type),
  scopes: cheer.scopes,
  schema: cheer.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const raid = subscriptions["channel.raid"];

export interface RaidOptions {
  /**
   * `incoming` receives raids into this channel; `outgoing` receives raids
   * this channel starts. Defaults to `incoming`.
   */
  readonly direction?: "incoming" | "outgoing";
}

/** `channel.raid` (no scope). */
export const Raid = Ballast.Topic<PayloadOf<typeof raid.type>, Integration, RaidOptions>({
  integration: INTEGRATION,
  topic: topicOf(raid.type),
  scopes: raid.scopes,
  schema: raid.payload,
  condition: (connection, options) =>
    options?.direction === "outgoing"
      ? { from_broadcaster_user_id: { slot: connection.slot } }
      : { to_broadcaster_user_id: { slot: connection.slot } },
});

const streamOnline = subscriptions["stream.online"];

/** `stream.online` (no scope). */
export const StreamOnline = Ballast.Topic<PayloadOf<typeof streamOnline.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(streamOnline.type),
  scopes: streamOnline.scopes,
  schema: streamOnline.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const streamOffline = subscriptions["stream.offline"];

/** `stream.offline` (no scope). */
export const StreamOffline = Ballast.Topic<PayloadOf<typeof streamOffline.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(streamOffline.type),
  scopes: streamOffline.scopes,
  schema: streamOffline.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const redemptionUpdate =
  subscriptions["channel.channel_points_custom_reward_redemption.update"];

/**
 * `channel.channel_points_custom_reward_redemption.update` (scope
 * `channel:read:redemptions`). Fires when a redemption is fulfilled or
 * canceled, including refunds.
 */
export const ChannelPointsRedemptionUpdate = Ballast.Topic<
  PayloadOf<typeof redemptionUpdate.type>,
  Integration,
  ChannelPointsRedemptionOptions
>({
  integration: INTEGRATION,
  topic: topicOf(redemptionUpdate.type),
  scopes: redemptionUpdate.scopes,
  schema: redemptionUpdate.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: connection.slot },
    ...(options?.rewardId === undefined ? {} : { reward_id: options.rewardId }),
  }),
});

const customRewardAdd = subscriptions["channel.channel_points_custom_reward.add"];

/** `channel.channel_points_custom_reward.add` (scope `channel:read:redemptions`). */
export const CustomRewardAdd = Ballast.Topic<
  PayloadOf<typeof customRewardAdd.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(customRewardAdd.type),
  scopes: customRewardAdd.scopes,
  schema: customRewardAdd.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

export interface CustomRewardOptions {
  /** Only receive changes for this reward, instead of every reward. */
  readonly rewardId?: string;
}

const customRewardUpdate = subscriptions["channel.channel_points_custom_reward.update"];

/** `channel.channel_points_custom_reward.update` (scope `channel:read:redemptions`). */
export const CustomRewardUpdate = Ballast.Topic<
  PayloadOf<typeof customRewardUpdate.type>,
  Integration,
  CustomRewardOptions
>({
  integration: INTEGRATION,
  topic: topicOf(customRewardUpdate.type),
  scopes: customRewardUpdate.scopes,
  schema: customRewardUpdate.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: connection.slot },
    ...(options?.rewardId === undefined ? {} : { reward_id: options.rewardId }),
  }),
});

const customRewardRemove = subscriptions["channel.channel_points_custom_reward.remove"];

/** `channel.channel_points_custom_reward.remove` (scope `channel:read:redemptions`). */
export const CustomRewardRemove = Ballast.Topic<
  PayloadOf<typeof customRewardRemove.type>,
  Integration,
  CustomRewardOptions
>({
  integration: INTEGRATION,
  topic: topicOf(customRewardRemove.type),
  scopes: customRewardRemove.scopes,
  schema: customRewardRemove.payload,
  condition: (connection, options) => ({
    broadcaster_user_id: { slot: connection.slot },
    ...(options?.rewardId === undefined ? {} : { reward_id: options.rewardId }),
  }),
});

const hypeTrainBegin = subscriptions["channel.hype_train.begin"];

/** `channel.hype_train.begin` v2 (scope `channel:read:hype_train`). */
export const HypeTrainBegin = Ballast.Topic<
  PayloadOf<typeof hypeTrainBegin.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(hypeTrainBegin.type),
  scopes: hypeTrainBegin.scopes,
  schema: hypeTrainBegin.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const hypeTrainProgress = subscriptions["channel.hype_train.progress"];

/** `channel.hype_train.progress` v2 (scope `channel:read:hype_train`). */
export const HypeTrainProgress = Ballast.Topic<
  PayloadOf<typeof hypeTrainProgress.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(hypeTrainProgress.type),
  scopes: hypeTrainProgress.scopes,
  schema: hypeTrainProgress.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const hypeTrainEnd = subscriptions["channel.hype_train.end"];

/** `channel.hype_train.end` v2 (scope `channel:read:hype_train`). */
export const HypeTrainEnd = Ballast.Topic<
  PayloadOf<typeof hypeTrainEnd.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(hypeTrainEnd.type),
  scopes: hypeTrainEnd.scopes,
  schema: hypeTrainEnd.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const pollBegin = subscriptions["channel.poll.begin"];

/** `channel.poll.begin` (scope `channel:read:polls`). */
export const PollBegin = Ballast.Topic<PayloadOf<typeof pollBegin.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(pollBegin.type),
  scopes: pollBegin.scopes,
  schema: pollBegin.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const pollProgress = subscriptions["channel.poll.progress"];

/** `channel.poll.progress` (scope `channel:read:polls`). */
export const PollProgress = Ballast.Topic<PayloadOf<typeof pollProgress.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(pollProgress.type),
  scopes: pollProgress.scopes,
  schema: pollProgress.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const pollEnd = subscriptions["channel.poll.end"];

/** `channel.poll.end` (scope `channel:read:polls`). */
export const PollEnd = Ballast.Topic<PayloadOf<typeof pollEnd.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(pollEnd.type),
  scopes: pollEnd.scopes,
  schema: pollEnd.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const predictionBegin = subscriptions["channel.prediction.begin"];

/** `channel.prediction.begin` (scope `channel:read:predictions`). */
export const PredictionBegin = Ballast.Topic<
  PayloadOf<typeof predictionBegin.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(predictionBegin.type),
  scopes: predictionBegin.scopes,
  schema: predictionBegin.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const predictionProgress = subscriptions["channel.prediction.progress"];

/** `channel.prediction.progress` (scope `channel:read:predictions`). */
export const PredictionProgress = Ballast.Topic<
  PayloadOf<typeof predictionProgress.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(predictionProgress.type),
  scopes: predictionProgress.scopes,
  schema: predictionProgress.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const predictionLock = subscriptions["channel.prediction.lock"];

/** `channel.prediction.lock` (scope `channel:read:predictions`). */
export const PredictionLock = Ballast.Topic<
  PayloadOf<typeof predictionLock.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(predictionLock.type),
  scopes: predictionLock.scopes,
  schema: predictionLock.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const predictionEnd = subscriptions["channel.prediction.end"];

/** `channel.prediction.end` (scope `channel:read:predictions`). */
export const PredictionEnd = Ballast.Topic<
  PayloadOf<typeof predictionEnd.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(predictionEnd.type),
  scopes: predictionEnd.scopes,
  schema: predictionEnd.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const channelUpdate = subscriptions["channel.update"];

/** `channel.update` v2 (no scope). */
export const ChannelUpdate = Ballast.Topic<PayloadOf<typeof channelUpdate.type>, Integration>({
  integration: INTEGRATION,
  topic: topicOf(channelUpdate.type),
  scopes: channelUpdate.scopes,
  schema: channelUpdate.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const subscriptionGift = subscriptions["channel.subscription.gift"];

/** `channel.subscription.gift` (scope `channel:read:subscriptions`). */
export const SubscriptionGift = Ballast.Topic<
  PayloadOf<typeof subscriptionGift.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(subscriptionGift.type),
  scopes: subscriptionGift.scopes,
  schema: subscriptionGift.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const subscriptionMessage = subscriptions["channel.subscription.message"];

/** `channel.subscription.message` (scope `channel:read:subscriptions`). */
export const SubscriptionMessage = Ballast.Topic<
  PayloadOf<typeof subscriptionMessage.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(subscriptionMessage.type),
  scopes: subscriptionMessage.scopes,
  schema: subscriptionMessage.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

const subscriptionEnd = subscriptions["channel.subscription.end"];

/** `channel.subscription.end` (scope `channel:read:subscriptions`). */
export const SubscriptionEnd = Ballast.Topic<
  PayloadOf<typeof subscriptionEnd.type>,
  Integration
>({
  integration: INTEGRATION,
  topic: topicOf(subscriptionEnd.type),
  scopes: subscriptionEnd.scopes,
  schema: subscriptionEnd.payload,
  condition: (connection) => ({
    broadcaster_user_id: { slot: connection.slot },
  }),
});

/**
 * The same topics as data, keyed by the friendly names in
 * `EventSub.topics`. Useful for tooling that only has a name.
 */
export const namedTopics = {
  ChannelPointsRedemption,
  ChannelPointsRedemptionUpdate,
  CustomRewardAdd,
  CustomRewardUpdate,
  CustomRewardRemove,
  ChatMessage,
  Follow,
  Subscribe,
  SubscriptionGift,
  SubscriptionMessage,
  SubscriptionEnd,
  Cheer,
  Raid,
  HypeTrainBegin,
  HypeTrainProgress,
  HypeTrainEnd,
  PollBegin,
  PollProgress,
  PollEnd,
  PredictionBegin,
  PredictionProgress,
  PredictionLock,
  PredictionEnd,
  ChannelUpdate,
  StreamOnline,
  StreamOffline,
} as const;

export type NamedTopic = keyof typeof namedTopics;
