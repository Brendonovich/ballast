import * as Schema from "effect/Schema";

/** Twitch Helix request definitions as data: method, path, schemas, scopes. */
export type HelixMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HelixRequest<Input, Output> {
  readonly name: string;
  readonly method: HelixMethod;
  readonly path: string;
  /** Scopes the user token needs. Empty means authorized but unscoped. */
  readonly scopes: ReadonlyArray<string>;
  readonly input: Schema.Codec<Input, unknown, never, never>;
  readonly output: Schema.Codec<Output, unknown, never, never>;
  readonly toQuery: (input: Input) => Readonly<Record<string, string>>;
  readonly toBody: (input: Input) => unknown;
  readonly docsUrl: string;
}

const queryRecord = (
  input: Readonly<Record<string, string | number | boolean | undefined>>,
): Readonly<Record<string, string>> => {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) entries.push([key, String(value)]);
  }
  return Object.fromEntries(entries);
};

const jsonBody = (
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

export const defineRequest = <Input, Output>(config: {
  readonly name: string;
  readonly method: HelixMethod;
  readonly path: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly input: Schema.Codec<Input, unknown, never, never>;
  readonly output: Schema.Codec<Output, unknown, never, never>;
  readonly query?: (input: Input) => Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: (input: Input) => Readonly<Record<string, unknown>>;
  readonly docsUrl: string;
}): HelixRequest<Input, Output> => ({
  name: config.name,
  method: config.method,
  path: config.path,
  scopes: config.scopes ?? [],
  input: config.input,
  output: config.output,
  toQuery: (input) => queryRecord(config.query?.(input) ?? {}),
  toBody: (input) => (config.body === undefined ? undefined : jsonBody(config.body(input))),
  docsUrl: config.docsUrl,
});

const apiDocs = (page: string, anchor: string) =>
  `https://dev.twitch.tv/docs/api/reference/${page}/#${anchor}`;

export const TwitchList = <A>(item: Schema.Codec<A, unknown, never, never>) =>
  Schema.Struct({ data: Schema.Array(item) });

export const Pagination = Schema.Struct({ cursor: Schema.optional(Schema.String) });
export type Pagination = Schema.Schema.Type<typeof Pagination>;

/** A paginated Helix response. Only some endpoints include `total`/`points`. */
export const TwitchPage = <A>(item: Schema.Codec<A, unknown, never, never>) =>
  Schema.Struct({
    data: Schema.Array(item),
    pagination: Schema.optional(Pagination),
    total: Schema.optional(Schema.Int),
    points: Schema.optional(Schema.Int),
  });

const Advertisement = Schema.Struct({
  length: Schema.Int,
  message: Schema.String,
  retry_after: Schema.Int,
});
export type Advertisement = Schema.Schema.Type<typeof Advertisement>;

export const User = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  display_name: Schema.String,
  type: Schema.String,
  broadcaster_type: Schema.String,
  description: Schema.String,
  profile_image_url: Schema.String,
  offline_image_url: Schema.String,
  view_count: Schema.Int,
  /** Present only when the token has `user:read:email`. */
  email: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.DateFromString,
});
export type User = Schema.Schema.Type<typeof User>;

export const ChannelInformation = Schema.Struct({
  broadcaster_id: Schema.String,
  broadcaster_login: Schema.String,
  broadcaster_name: Schema.String,
  broadcaster_language: Schema.String,
  game_id: Schema.String,
  game_name: Schema.String,
  title: Schema.String,
  delay: Schema.optional(Schema.Int),
  tags: Schema.optional(Schema.Array(Schema.String)),
  content_classification_labels: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, is_enabled: Schema.Boolean })),
  ),
  is_branded_content: Schema.optional(Schema.Boolean),
});
export type ChannelInformation = Schema.Schema.Type<typeof ChannelInformation>;

export const CustomReward = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  cost: Schema.Int,
  is_enabled: Schema.Boolean,
  is_user_input_required: Schema.Boolean,
  is_paused: Schema.Boolean,
  is_in_stock: Schema.Boolean,
  should_redemptions_skip_request_queue: Schema.Boolean,
  background_color: Schema.String,
  image: Schema.optional(Schema.NullOr(Schema.String)),
  default_image: Schema.optional(
    Schema.Struct({
      url_1x: Schema.String,
      url_2x: Schema.String,
      url_4x: Schema.String,
    }),
  ),
  broadcaster_id: Schema.optional(Schema.String),
  broadcaster_login: Schema.optional(Schema.String),
  broadcaster_name: Schema.optional(Schema.String),
  max_per_stream_setting: Schema.optional(
    Schema.Struct({ is_enabled: Schema.Boolean, max_per_stream: Schema.Int }),
  ),
  max_per_user_per_stream_setting: Schema.optional(
    Schema.Struct({ is_enabled: Schema.Boolean, max_per_user_per_stream: Schema.Int }),
  ),
  global_cooldown_setting: Schema.optional(
    Schema.Struct({ is_enabled: Schema.Boolean, global_cooldown_seconds: Schema.Int }),
  ),
  redemptions_redeemed_current_stream: Schema.optional(Schema.NullOr(Schema.Int)),
  cooldown_expires_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CustomReward = Schema.Schema.Type<typeof CustomReward>;

export const RedemptionStatus = Schema.Literals(["UNFULFILLED", "FULFILLED", "CANCELED"]);
export type RedemptionStatus = Schema.Schema.Type<typeof RedemptionStatus>;

export const CustomRewardRedemption = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
  user_input: Schema.String,
  status: RedemptionStatus,
  reward: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    prompt: Schema.String,
    cost: Schema.Int,
  }),
  redeemed_at: Schema.DateFromString,
  broadcaster_id: Schema.optional(Schema.String),
  broadcaster_login: Schema.optional(Schema.String),
  broadcaster_name: Schema.optional(Schema.String),
});
export type CustomRewardRedemption = Schema.Schema.Type<typeof CustomRewardRedemption>;

export const EventSubCondition = Schema.Record(Schema.String, Schema.String);

export const EventSubTransportRequest = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("webhook"),
    callback: Schema.String,
    secret: Schema.String,
  }),
  Schema.Struct({
    method: Schema.Literal("websocket"),
    session_id: Schema.String,
  }),
]);
export type EventSubTransportRequest = Schema.Schema.Type<typeof EventSubTransportRequest>;

export const EventSubTransport = Schema.Union([
  Schema.Struct({ method: Schema.Literal("webhook"), callback: Schema.String }),
  Schema.Struct({ method: Schema.Literal("websocket"), session_id: Schema.String }),
  Schema.Struct({ method: Schema.Literal("conduit"), conduit_id: Schema.String }),
]);

export const EventSubSubscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  version: Schema.String,
  condition: EventSubCondition,
  created_at: Schema.DateFromString,
  transport: Schema.optional(EventSubTransport),
  cost: Schema.optional(Schema.Int),
});
export type EventSubSubscription = Schema.Schema.Type<typeof EventSubSubscription>;

export const EventSubSubscriptionList = Schema.Struct({
  data: Schema.Array(EventSubSubscription),
  total: Schema.optional(Schema.Int),
  total_cost: Schema.optional(Schema.Int),
  max_total_cost: Schema.optional(Schema.Int),
  pagination: Schema.optional(Schema.Struct({ cursor: Schema.optional(Schema.String) })),
});
export type EventSubSubscriptionList = Schema.Schema.Type<typeof EventSubSubscriptionList>;

export const GetUsersInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
});
export type GetUsersInput = Schema.Schema.Type<typeof GetUsersInput>;

export const GetChannelInformationInput = Schema.Struct({
  broadcaster_id: Schema.String,
});

export const ModifyChannelInformationInput = Schema.Struct({
  broadcaster_id: Schema.String,
  game_id: Schema.optional(Schema.String),
  broadcaster_language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  content_classification_labels: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, is_enabled: Schema.Boolean })),
  ),
  is_branded_content: Schema.optional(Schema.Boolean),
});

const CustomRewardOptions = {
  prompt: Schema.optional(Schema.String),
  is_enabled: Schema.optional(Schema.Boolean),
  background_color: Schema.optional(Schema.String),
  is_user_input_required: Schema.optional(Schema.Boolean),
  is_max_per_stream_enabled: Schema.optional(Schema.Boolean),
  max_per_stream: Schema.optional(Schema.Int),
  is_max_per_user_per_stream_enabled: Schema.optional(Schema.Boolean),
  max_per_user_per_stream: Schema.optional(Schema.Int),
  is_global_cooldown_enabled: Schema.optional(Schema.Boolean),
  global_cooldown_seconds: Schema.optional(Schema.Int),
  should_redemptions_skip_request_queue: Schema.optional(Schema.Boolean),
} as const;

export const CreateCustomRewardInput = Schema.Struct({
  broadcaster_id: Schema.String,
  title: Schema.String,
  cost: Schema.Int,
  ...CustomRewardOptions,
});
export type CreateCustomRewardInput = Schema.Schema.Type<typeof CreateCustomRewardInput>;

export const UpdateCustomRewardInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.String,
  ...CustomRewardOptions,
  title: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Int),
});

export const DeleteCustomRewardInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.String,
});

export const GetCustomRewardsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.optional(Schema.String),
  only_manageable_rewards: Schema.optional(Schema.Boolean),
});

export const UpdateRedemptionStatusInput = Schema.Struct({
  broadcaster_id: Schema.String,
  reward_id: Schema.String,
  id: Schema.String,
  status: Schema.Literals(["FULFILLED", "CANCELED"]),
});
export type UpdateRedemptionStatusInput = Schema.Schema.Type<typeof UpdateRedemptionStatusInput>;

export const SendChatMessageInput = Schema.Struct({
  broadcaster_id: Schema.String,
  sender_id: Schema.String,
  message: Schema.String,
  reply_parent_message_id: Schema.optional(Schema.String),
  for_source_only: Schema.optional(Schema.Boolean),
});
export type SendChatMessageInput = Schema.Schema.Type<typeof SendChatMessageInput>;

export const SendChatMessageOutput = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      message_id: Schema.String,
      is_sent: Schema.Boolean,
      drop_reason: Schema.optional(
        Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
      ),
    }),
  ),
});
export type SendChatMessageOutput = Schema.Schema.Type<typeof SendChatMessageOutput>;

export const CreateClipInput = Schema.Struct({
  broadcaster_id: Schema.String,
  has_delay: Schema.optional(Schema.Boolean),
});
export type CreateClipInput = Schema.Schema.Type<typeof CreateClipInput>;

export const CreateClipOutput = TwitchList(
  Schema.Struct({ id: Schema.String, edit_url: Schema.String }),
);
export type CreateClipOutput = Schema.Schema.Type<typeof CreateClipOutput>;

export const StartCommercialInput = Schema.Struct({
  broadcaster_id: Schema.String,
  length: Schema.Int,
});
export type StartCommercialInput = Schema.Schema.Type<typeof StartCommercialInput>;

export const StartCommercialOutput = TwitchList(Advertisement);
export type StartCommercialOutput = Schema.Schema.Type<typeof StartCommercialOutput>;

export const CreateEventSubSubscriptionInput = Schema.Struct({
  type: Schema.String,
  version: Schema.String,
  condition: EventSubCondition,
  transport: EventSubTransportRequest,
});
export type CreateEventSubSubscriptionInput = Schema.Schema.Type<
  typeof CreateEventSubSubscriptionInput
>;

export const GetEventSubSubscriptionsInput = Schema.Struct({
  status: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  subscription_id: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Int),
});
export type GetEventSubSubscriptionsInput = Schema.Schema.Type<
  typeof GetEventSubSubscriptionsInput
>;

export const DeleteEventSubSubscriptionInput = Schema.Struct({ id: Schema.String });

export const PollChoice = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  votes: Schema.Int,
  channel_points_votes: Schema.Int,
});
export type PollChoice = Schema.Schema.Type<typeof PollChoice>;

export const PollStatus = Schema.Literals([
  "ACTIVE",
  "COMPLETED",
  "TERMINATED",
  "ARCHIVED",
  "MODERATED",
  "INVALID",
]);
export type PollStatus = Schema.Schema.Type<typeof PollStatus>;

export const Poll = Schema.Struct({
  id: Schema.String,
  broadcaster_id: Schema.String,
  broadcaster_name: Schema.String,
  broadcaster_login: Schema.String,
  title: Schema.String,
  choices: Schema.Array(PollChoice),
  channel_points_voting_enabled: Schema.Boolean,
  channel_points_per_vote: Schema.Int,
  status: PollStatus,
  duration: Schema.Int,
  started_at: Schema.DateFromString,
  ended_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
});
export type Poll = Schema.Schema.Type<typeof Poll>;

export const PollChoiceInput = Schema.Struct({ title: Schema.String });
export type PollChoiceInput = Schema.Schema.Type<typeof PollChoiceInput>;

export const CreatePollInput = Schema.Struct({
  broadcaster_id: Schema.String,
  title: Schema.String,
  choices: Schema.Array(PollChoiceInput),
  duration: Schema.Int,
  channel_points_voting_enabled: Schema.optional(Schema.Boolean),
  channel_points_per_vote: Schema.optional(Schema.Int),
});
export type CreatePollInput = Schema.Schema.Type<typeof CreatePollInput>;

export const GetPollsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Int),
  after: Schema.optional(Schema.String),
});
export type GetPollsInput = Schema.Schema.Type<typeof GetPollsInput>;

export const EndPollStatus = Schema.Literals(["TERMINATED", "ARCHIVED"]);
export type EndPollStatus = Schema.Schema.Type<typeof EndPollStatus>;

export const EndPollInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.String,
  status: EndPollStatus,
});
export type EndPollInput = Schema.Schema.Type<typeof EndPollInput>;

export const PredictionOutcomeColor = Schema.Literals(["BLUE", "PINK"]);
export type PredictionOutcomeColor = Schema.Schema.Type<typeof PredictionOutcomeColor>;

export const PredictionTopPredictor = Schema.Struct({
  user_id: Schema.String,
  user_name: Schema.String,
  user_login: Schema.String,
  channel_points_used: Schema.Int,
  channel_points_won: Schema.Int,
});
export type PredictionTopPredictor = Schema.Schema.Type<typeof PredictionTopPredictor>;

export const PredictionOutcome = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  users: Schema.Int,
  channel_points: Schema.Int,
  /** Null when nobody has predicted on this outcome yet. */
  top_predictors: Schema.optional(Schema.NullOr(Schema.Array(PredictionTopPredictor))),
  color: PredictionOutcomeColor,
});
export type PredictionOutcome = Schema.Schema.Type<typeof PredictionOutcome>;

export const PredictionStatus = Schema.Literals(["ACTIVE", "CANCELED", "LOCKED", "RESOLVED"]);
export type PredictionStatus = Schema.Schema.Type<typeof PredictionStatus>;

export const Prediction = Schema.Struct({
  id: Schema.String,
  broadcaster_id: Schema.String,
  broadcaster_name: Schema.String,
  broadcaster_login: Schema.String,
  title: Schema.String,
  winning_outcome_id: Schema.optional(Schema.NullOr(Schema.String)),
  outcomes: Schema.Array(PredictionOutcome),
  prediction_window: Schema.Int,
  status: PredictionStatus,
  created_at: Schema.DateFromString,
  ended_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
  locked_at: Schema.optional(Schema.NullOr(Schema.DateFromString)),
});
export type Prediction = Schema.Schema.Type<typeof Prediction>;

export const PredictionOutcomeInput = Schema.Struct({ title: Schema.String });
export type PredictionOutcomeInput = Schema.Schema.Type<typeof PredictionOutcomeInput>;

export const CreatePredictionInput = Schema.Struct({
  broadcaster_id: Schema.String,
  title: Schema.String,
  outcomes: Schema.Array(PredictionOutcomeInput),
  prediction_window: Schema.Int,
});
export type CreatePredictionInput = Schema.Schema.Type<typeof CreatePredictionInput>;

export const GetPredictionsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Int),
  after: Schema.optional(Schema.String),
});
export type GetPredictionsInput = Schema.Schema.Type<typeof GetPredictionsInput>;

export const EndPredictionStatus = Schema.Literals(["RESOLVED", "CANCELED"]);
export type EndPredictionStatus = Schema.Schema.Type<typeof EndPredictionStatus>;

export const EndPredictionInput = Schema.Struct({
  broadcaster_id: Schema.String,
  id: Schema.String,
  status: EndPredictionStatus,
  winning_outcome_id: Schema.optional(Schema.String),
});
export type EndPredictionInput = Schema.Schema.Type<typeof EndPredictionInput>;

export const Subscription = Schema.Struct({
  broadcaster_id: Schema.String,
  broadcaster_login: Schema.String,
  broadcaster_name: Schema.String,
  gifter_id: Schema.optional(Schema.String),
  gifter_login: Schema.optional(Schema.String),
  gifter_name: Schema.optional(Schema.String),
  is_gift: Schema.Boolean,
  plan_name: Schema.String,
  tier: Schema.Literals(["1000", "2000", "3000"]),
  user_id: Schema.String,
  user_name: Schema.String,
  user_login: Schema.String,
});
export type Subscription = Schema.Schema.Type<typeof Subscription>;

export const GetBroadcasterSubscriptionsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  user_id: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Int),
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
});
export type GetBroadcasterSubscriptionsInput = Schema.Schema.Type<
  typeof GetBroadcasterSubscriptionsInput
>;

export const CheckUserSubscriptionInput = Schema.Struct({
  broadcaster_id: Schema.String,
  user_id: Schema.String,
});
export type CheckUserSubscriptionInput = Schema.Schema.Type<typeof CheckUserSubscriptionInput>;

export const Stream = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
  game_id: Schema.String,
  game_name: Schema.String,
  type: Schema.Literal("live"),
  title: Schema.String,
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  viewer_count: Schema.Int,
  started_at: Schema.DateFromString,
  language: Schema.String,
  thumbnail_url: Schema.String,
  tag_ids: Schema.optional(Schema.Array(Schema.String)),
  is_mature: Schema.Boolean,
});
export type Stream = Schema.Schema.Type<typeof Stream>;

export const GetStreamsInput = Schema.Struct({
  user_id: Schema.optional(Schema.String),
  user_login: Schema.optional(Schema.String),
  game_id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literal("live")),
  first: Schema.optional(Schema.Int),
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
});
export type GetStreamsInput = Schema.Schema.Type<typeof GetStreamsInput>;

export const Chatter = Schema.Struct({
  user_id: Schema.String,
  user_login: Schema.String,
  user_name: Schema.String,
});
export type Chatter = Schema.Schema.Type<typeof Chatter>;

export const GetChattersInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  first: Schema.optional(Schema.Int),
  after: Schema.optional(Schema.String),
});
export type GetChattersInput = Schema.Schema.Type<typeof GetChattersInput>;

export const ChatSettings = Schema.Struct({
  broadcaster_id: Schema.String,
  emote_mode: Schema.Boolean,
  follower_mode: Schema.Boolean,
  follower_mode_duration: Schema.optional(Schema.NullOr(Schema.Int)),
  moderator_id: Schema.optional(Schema.String),
  non_moderator_chat_delay: Schema.optional(Schema.Boolean),
  non_moderator_chat_delay_duration: Schema.optional(Schema.NullOr(Schema.Int)),
  slow_mode: Schema.Boolean,
  slow_mode_wait_time: Schema.optional(Schema.NullOr(Schema.Int)),
  subscriber_mode: Schema.Boolean,
  unique_chat_mode: Schema.Boolean,
});
export type ChatSettings = Schema.Schema.Type<typeof ChatSettings>;

export const GetChatSettingsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.optional(Schema.String),
});
export type GetChatSettingsInput = Schema.Schema.Type<typeof GetChatSettingsInput>;

export const UpdateChatSettingsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  emote_mode: Schema.optional(Schema.Boolean),
  follower_mode: Schema.optional(Schema.Boolean),
  follower_mode_duration: Schema.optional(Schema.Int),
  non_moderator_chat_delay: Schema.optional(Schema.Boolean),
  non_moderator_chat_delay_duration: Schema.optional(Schema.Int),
  slow_mode: Schema.optional(Schema.Boolean),
  slow_mode_wait_time: Schema.optional(Schema.Int),
  subscriber_mode: Schema.optional(Schema.Boolean),
  unique_chat_mode: Schema.optional(Schema.Boolean),
});
export type UpdateChatSettingsInput = Schema.Schema.Type<typeof UpdateChatSettingsInput>;

export const AnnouncementColor = Schema.Literals(["blue", "green", "orange", "purple", "primary"]);
export type AnnouncementColor = Schema.Schema.Type<typeof AnnouncementColor>;

export const SendAnnouncementInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  message: Schema.String,
  color: Schema.optional(AnnouncementColor),
  for_source_only: Schema.optional(Schema.Boolean),
});
export type SendAnnouncementInput = Schema.Schema.Type<typeof SendAnnouncementInput>;

export const BanUserInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  user_id: Schema.String,
  duration: Schema.optional(Schema.Int),
  reason: Schema.optional(Schema.String),
});
export type BanUserInput = Schema.Schema.Type<typeof BanUserInput>;

export const UnbanUserInput = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  user_id: Schema.String,
});
export type UnbanUserInput = Schema.Schema.Type<typeof UnbanUserInput>;

export const Ban = Schema.Struct({
  broadcaster_id: Schema.String,
  moderator_id: Schema.String,
  user_id: Schema.String,
  created_at: Schema.DateFromString,
  end_time: Schema.optional(Schema.NullOr(Schema.DateFromString)),
});
export type Ban = Schema.Schema.Type<typeof Ban>;

export const ChannelVip = Schema.Struct({
  user_id: Schema.String,
  user_name: Schema.String,
  user_login: Schema.String,
});
export type ChannelVip = Schema.Schema.Type<typeof ChannelVip>;

export const GetChannelVipsInput = Schema.Struct({
  broadcaster_id: Schema.String,
  user_id: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Int),
  after: Schema.optional(Schema.String),
});
export type GetChannelVipsInput = Schema.Schema.Type<typeof GetChannelVipsInput>;

export const AddChannelVipInput = Schema.Struct({
  broadcaster_id: Schema.String,
  user_id: Schema.String,
});
export type AddChannelVipInput = Schema.Schema.Type<typeof AddChannelVipInput>;

export const RemoveChannelVipInput = Schema.Struct({
  broadcaster_id: Schema.String,
  user_id: Schema.String,
});
export type RemoveChannelVipInput = Schema.Schema.Type<typeof RemoveChannelVipInput>;

export const requests = {
  getUsers: defineRequest({
    name: "getUsers",
    method: "GET",
    path: "/users",
    input: GetUsersInput,
    output: TwitchList(User),
    query: (input) => ({ id: input.id, login: input.login }),
    docsUrl: apiDocs("users", "get-users"),
  }),
  getChannelInformation: defineRequest({
    name: "getChannelInformation",
    method: "GET",
    path: "/channels",
    input: GetChannelInformationInput,
    output: TwitchList(ChannelInformation),
    query: (input) => ({ broadcaster_id: input.broadcaster_id }),
    docsUrl: apiDocs("channels", "get-channel-information"),
  }),
  modifyChannelInformation: defineRequest({
    name: "modifyChannelInformation",
    method: "PATCH",
    path: "/channels",
    scopes: ["channel:manage:broadcast"],
    input: ModifyChannelInformationInput,
    output: Schema.Void,
    query: (input) => ({ broadcaster_id: input.broadcaster_id }),
    body: (input) =>
      jsonBody({
        game_id: input.game_id,
        broadcaster_language: input.broadcaster_language,
        title: input.title,
        tags: input.tags,
        content_classification_labels: input.content_classification_labels,
        is_branded_content: input.is_branded_content,
      }),
    docsUrl: apiDocs("channels", "modify-channel-information"),
  }),
  createCustomReward: defineRequest({
    name: "createCustomReward",
    method: "POST",
    path: "/channel_points/custom_rewards",
    scopes: ["channel:manage:redemptions"],
    input: CreateCustomRewardInput,
    output: TwitchList(CustomReward),
    query: (input) => ({ broadcaster_id: input.broadcaster_id }),
    body: (input) =>
      jsonBody({
        title: input.title,
        cost: input.cost,
        prompt: input.prompt,
        is_enabled: input.is_enabled,
        background_color: input.background_color,
        is_user_input_required: input.is_user_input_required,
        is_max_per_stream_enabled: input.is_max_per_stream_enabled,
        max_per_stream: input.max_per_stream,
        is_max_per_user_per_stream_enabled: input.is_max_per_user_per_stream_enabled,
        max_per_user_per_stream: input.max_per_user_per_stream,
        is_global_cooldown_enabled: input.is_global_cooldown_enabled,
        global_cooldown_seconds: input.global_cooldown_seconds,
        should_redemptions_skip_request_queue: input.should_redemptions_skip_request_queue,
      }),
    docsUrl: apiDocs("channel-points", "create-custom-rewards"),
  }),
  updateCustomReward: defineRequest({
    name: "updateCustomReward",
    method: "PATCH",
    path: "/channel_points/custom_rewards",
    scopes: ["channel:manage:redemptions"],
    input: UpdateCustomRewardInput,
    output: TwitchList(CustomReward),
    query: (input) => ({ broadcaster_id: input.broadcaster_id, id: input.id }),
    body: (input) =>
      jsonBody({
        title: input.title,
        cost: input.cost,
        prompt: input.prompt,
        is_enabled: input.is_enabled,
        background_color: input.background_color,
        is_user_input_required: input.is_user_input_required,
        is_max_per_stream_enabled: input.is_max_per_stream_enabled,
        max_per_stream: input.max_per_stream,
        is_max_per_user_per_stream_enabled: input.is_max_per_user_per_stream_enabled,
        max_per_user_per_stream: input.max_per_user_per_stream,
        is_global_cooldown_enabled: input.is_global_cooldown_enabled,
        global_cooldown_seconds: input.global_cooldown_seconds,
        should_redemptions_skip_request_queue: input.should_redemptions_skip_request_queue,
      }),
    docsUrl: apiDocs("channel-points", "update-custom-reward"),
  }),
  deleteCustomReward: defineRequest({
    name: "deleteCustomReward",
    method: "DELETE",
    path: "/channel_points/custom_rewards",
    scopes: ["channel:manage:redemptions"],
    input: DeleteCustomRewardInput,
    output: Schema.Void,
    query: (input) => ({ broadcaster_id: input.broadcaster_id, id: input.id }),
    docsUrl: apiDocs("channel-points", "delete-custom-reward"),
  }),
  getCustomRewards: defineRequest({
    name: "getCustomRewards",
    method: "GET",
    path: "/channel_points/custom_rewards",
    scopes: ["channel:read:redemptions"],
    input: GetCustomRewardsInput,
    output: TwitchList(CustomReward),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      id: input.id,
      only_manageable_rewards: input.only_manageable_rewards,
    }),
    docsUrl: apiDocs("channel-points", "get-custom-reward"),
  }),
  updateRedemptionStatus: defineRequest({
    name: "updateRedemptionStatus",
    method: "PATCH",
    path: "/channel_points/custom_rewards/redemptions",
    scopes: ["channel:manage:redemptions"],
    input: UpdateRedemptionStatusInput,
    output: TwitchList(CustomRewardRedemption),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      reward_id: input.reward_id,
      id: input.id,
    }),
    body: (input) => jsonBody({ status: input.status }),
    docsUrl: apiDocs("channel-points", "update-redemption-status"),
  }),
  sendChatMessage: defineRequest({
    name: "sendChatMessage",
    method: "POST",
    path: "/chat/messages",
    scopes: ["user:write:chat"],
    input: SendChatMessageInput,
    output: SendChatMessageOutput,
    body: (input) =>
      jsonBody({
        broadcaster_id: input.broadcaster_id,
        sender_id: input.sender_id,
        message: input.message,
        reply_parent_message_id: input.reply_parent_message_id,
        for_source_only: input.for_source_only,
      }),
    docsUrl: apiDocs("chat", "send-chat-message"),
  }),
  createClip: defineRequest({
    name: "createClip",
    method: "POST",
    path: "/clips",
    scopes: ["clips:edit"],
    input: CreateClipInput,
    output: CreateClipOutput,
    query: (input) => ({ broadcaster_id: input.broadcaster_id, has_delay: input.has_delay }),
    docsUrl: apiDocs("clips", "create-clip"),
  }),
  startCommercial: defineRequest({
    name: "startCommercial",
    method: "POST",
    path: "/channels/commercial",
    scopes: ["channel:edit:commercial"],
    input: StartCommercialInput,
    output: StartCommercialOutput,
    body: (input) => jsonBody({ broadcaster_id: input.broadcaster_id, length: input.length }),
    docsUrl: apiDocs("ads", "start-commercial"),
  }),
  createEventSubSubscription: defineRequest({
    name: "createEventSubSubscription",
    method: "POST",
    path: "/eventsub/subscriptions",
    input: CreateEventSubSubscriptionInput,
    output: EventSubSubscriptionList,
    body: (input) =>
      jsonBody({
        type: input.type,
        version: input.version,
        condition: input.condition,
        transport: input.transport,
      }),
    docsUrl: apiDocs("eventsub", "create-eventsub-subscription"),
  }),
  getEventSubSubscriptions: defineRequest({
    name: "getEventSubSubscriptions",
    method: "GET",
    path: "/eventsub/subscriptions",
    input: GetEventSubSubscriptionsInput,
    output: EventSubSubscriptionList,
    query: (input) => ({
      status: input.status,
      type: input.type,
      user_id: input.user_id,
      subscription_id: input.subscription_id,
      after: input.after,
      first: input.first,
    }),
    docsUrl: apiDocs("eventsub", "get-eventsub-subscriptions"),
  }),
  deleteEventSubSubscription: defineRequest({
    name: "deleteEventSubSubscription",
    method: "DELETE",
    path: "/eventsub/subscriptions",
    input: DeleteEventSubSubscriptionInput,
    output: Schema.Void,
    query: (input) => ({ id: input.id }),
    docsUrl: apiDocs("eventsub", "delete-eventsub-subscription"),
  }),
  createPoll: defineRequest({
    name: "createPoll",
    method: "POST",
    path: "/polls",
    scopes: ["channel:manage:polls"],
    input: CreatePollInput,
    output: TwitchList(Poll),
    body: (input) =>
      jsonBody({
        broadcaster_id: input.broadcaster_id,
        title: input.title,
        choices: input.choices,
        duration: input.duration,
        channel_points_voting_enabled: input.channel_points_voting_enabled,
        channel_points_per_vote: input.channel_points_per_vote,
      }),
    docsUrl: apiDocs("polls", "create-poll"),
  }),
  getPolls: defineRequest({
    name: "getPolls",
    method: "GET",
    path: "/polls",
    scopes: ["channel:read:polls"],
    input: GetPollsInput,
    output: TwitchPage(Poll),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      id: input.id,
      first: input.first,
      after: input.after,
    }),
    docsUrl: apiDocs("polls", "get-polls"),
  }),
  endPoll: defineRequest({
    name: "endPoll",
    method: "PATCH",
    path: "/polls",
    scopes: ["channel:manage:polls"],
    input: EndPollInput,
    output: TwitchList(Poll),
    body: (input) =>
      jsonBody({
        broadcaster_id: input.broadcaster_id,
        id: input.id,
        status: input.status,
      }),
    docsUrl: apiDocs("polls", "end-poll"),
  }),
  createPrediction: defineRequest({
    name: "createPrediction",
    method: "POST",
    path: "/predictions",
    scopes: ["channel:manage:predictions"],
    input: CreatePredictionInput,
    output: TwitchList(Prediction),
    body: (input) =>
      jsonBody({
        broadcaster_id: input.broadcaster_id,
        title: input.title,
        outcomes: input.outcomes,
        prediction_window: input.prediction_window,
      }),
    docsUrl: apiDocs("predictions", "create-prediction"),
  }),
  getPredictions: defineRequest({
    name: "getPredictions",
    method: "GET",
    path: "/predictions",
    scopes: ["channel:read:predictions"],
    input: GetPredictionsInput,
    output: TwitchPage(Prediction),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      id: input.id,
      first: input.first,
      after: input.after,
    }),
    docsUrl: apiDocs("predictions", "get-predictions"),
  }),
  endPrediction: defineRequest({
    name: "endPrediction",
    method: "PATCH",
    path: "/predictions",
    scopes: ["channel:manage:predictions"],
    input: EndPredictionInput,
    output: TwitchList(Prediction),
    body: (input) =>
      jsonBody({
        broadcaster_id: input.broadcaster_id,
        id: input.id,
        status: input.status,
        winning_outcome_id: input.winning_outcome_id,
      }),
    docsUrl: apiDocs("predictions", "end-prediction"),
  }),
  getBroadcasterSubscriptions: defineRequest({
    name: "getBroadcasterSubscriptions",
    method: "GET",
    path: "/subscriptions",
    scopes: ["channel:read:subscriptions"],
    input: GetBroadcasterSubscriptionsInput,
    output: TwitchPage(Subscription),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      user_id: input.user_id,
      first: input.first,
      after: input.after,
      before: input.before,
    }),
    docsUrl: apiDocs("subscriptions", "get-broadcaster-subscriptions"),
  }),
  checkUserSubscription: defineRequest({
    name: "checkUserSubscription",
    method: "GET",
    path: "/subscriptions/user",
    scopes: ["user:read:subscriptions"],
    input: CheckUserSubscriptionInput,
    output: TwitchList(Subscription),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      user_id: input.user_id,
    }),
    docsUrl: apiDocs("subscriptions", "check-user-subscription"),
  }),
  getStreams: defineRequest({
    name: "getStreams",
    method: "GET",
    path: "/streams",
    input: GetStreamsInput,
    output: TwitchPage(Stream),
    query: (input) => ({
      user_id: input.user_id,
      user_login: input.user_login,
      game_id: input.game_id,
      type: input.type,
      first: input.first,
      before: input.before,
      after: input.after,
    }),
    docsUrl: apiDocs("streams", "get-streams"),
  }),
  getChatters: defineRequest({
    name: "getChatters",
    method: "GET",
    path: "/chat/chatters",
    scopes: ["moderator:read:chatters"],
    input: GetChattersInput,
    output: TwitchPage(Chatter),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
      first: input.first,
      after: input.after,
    }),
    docsUrl: apiDocs("chat", "get-chatters"),
  }),
  getChatSettings: defineRequest({
    name: "getChatSettings",
    method: "GET",
    path: "/chat/settings",
    input: GetChatSettingsInput,
    output: TwitchList(ChatSettings),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
    }),
    docsUrl: apiDocs("chat", "get-chat-settings"),
  }),
  updateChatSettings: defineRequest({
    name: "updateChatSettings",
    method: "PATCH",
    path: "/chat/settings",
    scopes: ["moderator:manage:chat_settings"],
    input: UpdateChatSettingsInput,
    output: TwitchList(ChatSettings),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
    }),
    body: (input) =>
      jsonBody({
        emote_mode: input.emote_mode,
        follower_mode: input.follower_mode,
        follower_mode_duration: input.follower_mode_duration,
        non_moderator_chat_delay: input.non_moderator_chat_delay,
        non_moderator_chat_delay_duration: input.non_moderator_chat_delay_duration,
        slow_mode: input.slow_mode,
        slow_mode_wait_time: input.slow_mode_wait_time,
        subscriber_mode: input.subscriber_mode,
        unique_chat_mode: input.unique_chat_mode,
      }),
    docsUrl: apiDocs("chat", "update-chat-settings"),
  }),
  sendAnnouncement: defineRequest({
    name: "sendAnnouncement",
    method: "POST",
    path: "/chat/announcements",
    scopes: ["moderator:manage:announcements"],
    input: SendAnnouncementInput,
    output: Schema.Void,
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
    }),
    body: (input) =>
      jsonBody({
        message: input.message,
        color: input.color,
        for_source_only: input.for_source_only,
      }),
    docsUrl: apiDocs("chat", "send-chat-announcement"),
  }),
  banUser: defineRequest({
    name: "banUser",
    method: "POST",
    path: "/moderation/bans",
    scopes: ["moderator:manage:banned_users"],
    input: BanUserInput,
    output: TwitchList(Ban),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
    }),
    body: (input) =>
      jsonBody({
        data: jsonBody({
          user_id: input.user_id,
          duration: input.duration,
          reason: input.reason,
        }),
      }),
    docsUrl: apiDocs("moderation", "ban-user"),
  }),
  unbanUser: defineRequest({
    name: "unbanUser",
    method: "DELETE",
    path: "/moderation/bans",
    scopes: ["moderator:manage:banned_users"],
    input: UnbanUserInput,
    output: Schema.Void,
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      moderator_id: input.moderator_id,
      user_id: input.user_id,
    }),
    docsUrl: apiDocs("moderation", "unban-user"),
  }),
  getChannelVips: defineRequest({
    name: "getChannelVips",
    method: "GET",
    path: "/channels/vips",
    scopes: ["channel:read:vips"],
    input: GetChannelVipsInput,
    output: TwitchPage(ChannelVip),
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      user_id: input.user_id,
      first: input.first,
      after: input.after,
    }),
    docsUrl: apiDocs("moderation", "get-vips"),
  }),
  addChannelVip: defineRequest({
    name: "addChannelVip",
    method: "POST",
    path: "/channels/vips",
    scopes: ["channel:manage:vips"],
    input: AddChannelVipInput,
    output: Schema.Void,
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      user_id: input.user_id,
    }),
    docsUrl: apiDocs("moderation", "add-channel-vip"),
  }),
  removeChannelVip: defineRequest({
    name: "removeChannelVip",
    method: "DELETE",
    path: "/channels/vips",
    scopes: ["channel:manage:vips"],
    input: RemoveChannelVipInput,
    output: Schema.Void,
    query: (input) => ({
      broadcaster_id: input.broadcaster_id,
      user_id: input.user_id,
    }),
    docsUrl: apiDocs("moderation", "remove-channel-vip"),
  }),
} as const;

export type Requests = typeof requests;
export type RequestName = keyof Requests;

export const isRequestName = (value: string): value is RequestName =>
  Object.hasOwn(requests, value);
