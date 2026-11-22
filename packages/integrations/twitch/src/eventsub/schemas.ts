import * as Schema from "effect/Schema";

/**
 * Payload schemas for the EventSub subscription types Ballast subscribes to
 * first. Field names are Twitch's wire names; timestamps decode to Date.
 */

export const BroadcasterFields = {
  broadcaster_user_id: Schema.String,
  broadcaster_user_login: Schema.String,
  broadcaster_user_name: Schema.String,
} as const;

export const UserFields = {
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
} as const;

export const RedemptionStatus = Schema.Literals(["unknown", "unfulfilled", "fulfilled", "canceled"]);
export type RedemptionStatus = Schema.Schema.Type<typeof RedemptionStatus>;

export const CustomReward = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  cost: Schema.Int,
  prompt: Schema.String,
});
export type CustomReward = Schema.Schema.Type<typeof CustomReward>;

export const ChannelPointsRedemptionAddPayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  ...UserFields,
  user_input: Schema.String,
  status: RedemptionStatus,
  reward: CustomReward,
  redeemed_at: Schema.DateFromString,
});
export type ChannelPointsRedemptionAddPayload = Schema.Schema.Type<
  typeof ChannelPointsRedemptionAddPayload
>;

export const ChatEmote = Schema.Struct({
  id: Schema.String,
  emote_set_id: Schema.String,
  owner_id: Schema.String,
  format: Schema.Array(Schema.Literals(["static", "animated"])),
});
export type ChatEmote = Schema.Schema.Type<typeof ChatEmote>;

export const ChatCheermote = Schema.Struct({
  prefix: Schema.String,
  bits: Schema.Int,
  tier: Schema.Int,
});
export type ChatCheermote = Schema.Schema.Type<typeof ChatCheermote>;

export const ChatMention = Schema.Struct({
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
});

export const ChatGif = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
});

export const ChatFragment = Schema.Struct({
  type: Schema.Literals(["text", "cheermote", "emote", "mention", "gif"]),
  text: Schema.String,
  cheermote: Schema.optional(Schema.NullOr(ChatCheermote)),
  emote: Schema.optional(Schema.NullOr(ChatEmote)),
  mention: Schema.optional(Schema.NullOr(ChatMention)),
  gif: Schema.optional(Schema.NullOr(ChatGif)),
});
export type ChatFragment = Schema.Schema.Type<typeof ChatFragment>;

export const ChatMessage = Schema.Struct({
  text: Schema.String,
  fragments: Schema.Array(ChatFragment),
});
export type ChatMessage = Schema.Schema.Type<typeof ChatMessage>;

export const ChatBadge = Schema.Struct({
  set_id: Schema.String,
  id: Schema.String,
  info: Schema.String,
});
export type ChatBadge = Schema.Schema.Type<typeof ChatBadge>;

export const ChatReply = Schema.Struct({
  parent_message_id: Schema.String,
  parent_message_body: Schema.String,
  parent_user_id: Schema.String,
  parent_user_login: Schema.String,
  parent_user_name: Schema.String,
  thread_message_id: Schema.String,
  thread_user_id: Schema.String,
  thread_user_login: Schema.String,
  thread_user_name: Schema.String,
});
export type ChatReply = Schema.Schema.Type<typeof ChatReply>;

export const ChatMessageType = Schema.Literals([
  "text",
  "channel_points_highlighted",
  "channel_points_sub_only",
  "user_intro",
  "power_ups_message_effect",
  "power_ups_gigantified_emote",
]);

export const ChatMessagePayload = Schema.Struct({
  ...BroadcasterFields,
  chatter_user_id: Schema.String,
  chatter_user_login: Schema.String,
  chatter_user_name: Schema.String,
  message_id: Schema.String,
  message: ChatMessage,
  color: Schema.String,
  badges: Schema.Array(ChatBadge),
  message_type: ChatMessageType,
  cheer: Schema.optional(Schema.NullOr(Schema.Struct({ bits: Schema.Int }))),
  reply: Schema.optional(Schema.NullOr(ChatReply)),
  channel_points_custom_reward_id: Schema.optional(Schema.NullOr(Schema.String)),
  channel_points_animation_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_login: Schema.optional(Schema.NullOr(Schema.String)),
  source_broadcaster_user_name: Schema.optional(Schema.NullOr(Schema.String)),
  source_message_id: Schema.optional(Schema.NullOr(Schema.String)),
  source_badges: Schema.optional(Schema.NullOr(Schema.Array(ChatBadge))),
  is_source_only: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type ChatMessagePayload = Schema.Schema.Type<typeof ChatMessagePayload>;

export const FollowPayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  followed_at: Schema.DateFromString,
});
export type FollowPayload = Schema.Schema.Type<typeof FollowPayload>;

export const SubscribePayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: Schema.Literals(["1000", "2000", "3000"]),
  is_gift: Schema.Boolean,
});
export type SubscribePayload = Schema.Schema.Type<typeof SubscribePayload>;

export const CheerPayload = Schema.Struct({
  is_anonymous: Schema.Boolean,
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_login: Schema.optional(Schema.NullOr(Schema.String)),
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
  ...BroadcasterFields,
  message: Schema.String,
  bits: Schema.Int,
});
export type CheerPayload = Schema.Schema.Type<typeof CheerPayload>;

export const RaidPayload = Schema.Struct({
  from_broadcaster_user_id: Schema.String,
  from_broadcaster_user_login: Schema.String,
  from_broadcaster_user_name: Schema.String,
  to_broadcaster_user_id: Schema.String,
  to_broadcaster_user_login: Schema.String,
  to_broadcaster_user_name: Schema.String,
  viewers: Schema.Int,
});
export type RaidPayload = Schema.Schema.Type<typeof RaidPayload>;

export const StreamOnlinePayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  type: Schema.Literal("live"),
  started_at: Schema.DateFromString,
});
export type StreamOnlinePayload = Schema.Schema.Type<typeof StreamOnlinePayload>;

export const StreamOfflinePayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  ...BroadcasterFields,
});
export type StreamOfflinePayload = Schema.Schema.Type<typeof StreamOfflinePayload>;
