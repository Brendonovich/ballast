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

/** Payload shared by the redemption add and update events. */
export const ChannelPointsRedemptionPayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  ...UserFields,
  user_input: Schema.String,
  status: RedemptionStatus,
  reward: CustomReward,
  redeemed_at: Schema.DateFromString,
});
export type ChannelPointsRedemptionPayload = Schema.Schema.Type<
  typeof ChannelPointsRedemptionPayload
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

export const SubscriptionTier = Schema.Literals(["1000", "2000", "3000"]);
export type SubscriptionTier = Schema.Schema.Type<typeof SubscriptionTier>;

export const SubscribePayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: SubscriptionTier,
  is_gift: Schema.Boolean,
});
export type SubscribePayload = Schema.Schema.Type<typeof SubscribePayload>;

export const SubscriptionGiftPayload = Schema.Struct({
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_login: Schema.optional(Schema.NullOr(Schema.String)),
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
  ...BroadcasterFields,
  total: Schema.Int,
  tier: SubscriptionTier,
  cumulative_total: Schema.optional(Schema.NullOr(Schema.Int)),
  is_anonymous: Schema.Boolean,
});
export type SubscriptionGiftPayload = Schema.Schema.Type<typeof SubscriptionGiftPayload>;

export const SubscriptionMessageEmote = Schema.Struct({
  begin: Schema.Int,
  end: Schema.Int,
  id: Schema.String,
});
export type SubscriptionMessageEmote = Schema.Schema.Type<typeof SubscriptionMessageEmote>;

export const SubscriptionMessageBody = Schema.Struct({
  text: Schema.String,
  emotes: Schema.Array(SubscriptionMessageEmote),
});
export type SubscriptionMessageBody = Schema.Schema.Type<typeof SubscriptionMessageBody>;

export const SubscriptionMessagePayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: SubscriptionTier,
  message: SubscriptionMessageBody,
  cumulative_months: Schema.Int,
  streak_months: Schema.optional(Schema.NullOr(Schema.Int)),
  duration_months: Schema.Int,
});
export type SubscriptionMessagePayload = Schema.Schema.Type<typeof SubscriptionMessagePayload>;

export const SubscriptionEndPayload = Schema.Struct({
  ...UserFields,
  ...BroadcasterFields,
  tier: SubscriptionTier,
  is_gift: Schema.Boolean,
});
export type SubscriptionEndPayload = Schema.Schema.Type<typeof SubscriptionEndPayload>;

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


/* Channel updates */

export const ChannelUpdatePayload = Schema.Struct({
  ...BroadcasterFields,
  title: Schema.String,
  language: Schema.String,
  category_id: Schema.String,
  category_name: Schema.String,
  content_classification_labels: Schema.Array(Schema.String),
});
export type ChannelUpdatePayload = Schema.Schema.Type<typeof ChannelUpdatePayload>;

/* Channel points custom rewards */

export const CustomRewardImage = Schema.Struct({
  url_1x: Schema.String,
  url_2x: Schema.String,
  url_4x: Schema.String,
});
export type CustomRewardImage = Schema.Schema.Type<typeof CustomRewardImage>;

export const CustomRewardLimit = Schema.Struct({
  is_enabled: Schema.Boolean,
  value: Schema.Int,
});
export type CustomRewardLimit = Schema.Schema.Type<typeof CustomRewardLimit>;

export const CustomRewardCooldown = Schema.Struct({
  is_enabled: Schema.Boolean,
  seconds: Schema.Int,
});
export type CustomRewardCooldown = Schema.Schema.Type<typeof CustomRewardCooldown>;

/** Payload shared by the custom reward add, update and remove events. */
export const CustomRewardEventPayload = Schema.Struct({
  id: Schema.String,
  ...BroadcasterFields,
  is_enabled: Schema.Boolean,
  is_paused: Schema.Boolean,
  is_in_stock: Schema.Boolean,
  title: Schema.String,
  cost: Schema.Int,
  prompt: Schema.String,
  is_user_input_required: Schema.Boolean,
  should_redemptions_skip_request_queue: Schema.Boolean,
  max_per_stream: CustomRewardLimit,
  max_per_user_per_stream: CustomRewardLimit,
  background_color: Schema.String,
  image: Schema.optional(Schema.NullOr(CustomRewardImage)),
  default_image: Schema.optional(Schema.NullOr(CustomRewardImage)),
  global_cooldown: CustomRewardCooldown,
  cooldown_expires_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
  redemptions_redeemed_current_stream: Schema.optional(Schema.NullOr(Schema.Int)),
});
export type CustomRewardEventPayload = Schema.Schema.Type<typeof CustomRewardEventPayload>;

/* Hype trains */

export const HypeTrainContributionType = Schema.Literals(["bits", "subscription", "other"]);
export type HypeTrainContributionType = Schema.Schema.Type<typeof HypeTrainContributionType>;

export const HypeTrainContribution = Schema.Struct({
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
  type: HypeTrainContributionType,
  total: Schema.Int,
});
export type HypeTrainContribution = Schema.Schema.Type<typeof HypeTrainContribution>;

export const HypeTrainSharedParticipant = Schema.Struct({
  broadcaster_user_id: Schema.String,
  broadcaster_user_login: Schema.String,
  broadcaster_user_name: Schema.String,
});
export type HypeTrainSharedParticipant = Schema.Schema.Type<typeof HypeTrainSharedParticipant>;

export const HypeTrainType = Schema.Literals(["treasure", "golden_kappa", "regular"]);
export type HypeTrainType = Schema.Schema.Type<typeof HypeTrainType>;

const HypeTrainFields = {
  id: Schema.String,
  ...BroadcasterFields,
  total: Schema.Int,
  top_contributions: Schema.Array(HypeTrainContribution),
  level: Schema.Int,
  shared_train_participants: Schema.optional(
    Schema.NullOr(Schema.Array(HypeTrainSharedParticipant)),
  ),
  is_shared_train: Schema.Boolean,
  type: HypeTrainType,
} as const;

export const HypeTrainBeginPayload = Schema.Struct({
  ...HypeTrainFields,
  progress: Schema.Int,
  goal: Schema.Int,
  all_time_high_level: Schema.Int,
  all_time_high_total: Schema.Int,
  started_at: Schema.DateFromString,
  expires_at: Schema.DateFromString,
});
export type HypeTrainBeginPayload = Schema.Schema.Type<typeof HypeTrainBeginPayload>;

export const HypeTrainProgressPayload = Schema.Struct({
  ...HypeTrainFields,
  progress: Schema.Int,
  goal: Schema.Int,
  started_at: Schema.DateFromString,
  expires_at: Schema.DateFromString,
});
export type HypeTrainProgressPayload = Schema.Schema.Type<typeof HypeTrainProgressPayload>;

export const HypeTrainEndPayload = Schema.Struct({
  ...HypeTrainFields,
  started_at: Schema.DateFromString,
  ended_at: Schema.DateFromString,
  cooldown_ends_at: Schema.DateFromString,
});
export type HypeTrainEndPayload = Schema.Schema.Type<typeof HypeTrainEndPayload>;

/* Polls */

export const PollChoice = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  votes: Schema.Int,
  bits_votes: Schema.Int,
  channel_points_votes: Schema.Int,
});
export type PollChoice = Schema.Schema.Type<typeof PollChoice>;

export const PollVoting = Schema.Struct({
  is_enabled: Schema.Boolean,
  amount_per_vote: Schema.Int,
});
export type PollVoting = Schema.Schema.Type<typeof PollVoting>;

const PollFields = {
  id: Schema.String,
  ...BroadcasterFields,
  title: Schema.String,
  choices: Schema.Array(PollChoice),
  bits_voting: PollVoting,
  channel_points_voting: PollVoting,
} as const;

export const PollBeginPayload = Schema.Struct({
  ...PollFields,
  started_at: Schema.DateFromString,
  ends_at: Schema.DateFromString,
});
export type PollBeginPayload = Schema.Schema.Type<typeof PollBeginPayload>;

export const PollProgressPayload = Schema.Struct({
  ...PollFields,
  started_at: Schema.DateFromString,
  ends_at: Schema.DateFromString,
});
export type PollProgressPayload = Schema.Schema.Type<typeof PollProgressPayload>;

export const PollEndStatus = Schema.Literals(["completed", "archived", "terminated"]);
export type PollEndStatus = Schema.Schema.Type<typeof PollEndStatus>;

export const PollEndPayload = Schema.Struct({
  ...PollFields,
  status: PollEndStatus,
  started_at: Schema.DateFromString,
  ended_at: Schema.DateFromString,
});
export type PollEndPayload = Schema.Schema.Type<typeof PollEndPayload>;

/* Channel Points Predictions */

export const PredictionOutcomeColor = Schema.Literals(["blue", "pink"]);
export type PredictionOutcomeColor = Schema.Schema.Type<typeof PredictionOutcomeColor>;

export const PredictionTopPredictor = Schema.Struct({
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
  channel_points_won: Schema.optional(Schema.NullOr(Schema.Int)),
  channel_points_used: Schema.Int,
});
export type PredictionTopPredictor = Schema.Schema.Type<typeof PredictionTopPredictor>;

export const PredictionOutcome = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  color: PredictionOutcomeColor,
  users: Schema.Int,
  channel_points: Schema.Int,
  top_predictors: Schema.Array(PredictionTopPredictor),
});
export type PredictionOutcome = Schema.Schema.Type<typeof PredictionOutcome>;

const PredictionFields = {
  id: Schema.String,
  ...BroadcasterFields,
  title: Schema.String,
  outcomes: Schema.Array(PredictionOutcome),
  started_at: Schema.DateFromString,
  locks_at: Schema.DateFromString,
} as const;

export const PredictionBeginPayload = Schema.Struct(PredictionFields);
export type PredictionBeginPayload = Schema.Schema.Type<typeof PredictionBeginPayload>;

export const PredictionProgressPayload = Schema.Struct(PredictionFields);
export type PredictionProgressPayload = Schema.Schema.Type<typeof PredictionProgressPayload>;

export const PredictionLockPayload = Schema.Struct(PredictionFields);
export type PredictionLockPayload = Schema.Schema.Type<typeof PredictionLockPayload>;

export const PredictionEndStatus = Schema.Literals(["resolved", "canceled"]);
export type PredictionEndStatus = Schema.Schema.Type<typeof PredictionEndStatus>;

export const PredictionEndPayload = Schema.Struct({
  ...PredictionFields,
  winning_outcome_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: PredictionEndStatus,
  ended_at: Schema.DateFromString,
});
export type PredictionEndPayload = Schema.Schema.Type<typeof PredictionEndPayload>;
