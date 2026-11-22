import * as Schema from "effect/Schema";

/** Twitch Helix request definitions as data: method, path, schemas, scopes. */
export type HelixMethod = "GET" | "POST" | "PATCH" | "DELETE";

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

const apiDocs = (anchor: string) => "https://dev.twitch.tv/docs/api/reference/#" + anchor;

export const TwitchList = <A>(item: Schema.Codec<A, unknown, never, never>) =>
  Schema.Struct({ data: Schema.Array(item) });

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

export const requests = {
  getUsers: defineRequest({
    name: "getUsers",
    method: "GET",
    path: "/users",
    input: GetUsersInput,
    output: TwitchList(User),
    query: (input) => ({ id: input.id, login: input.login }),
    docsUrl: apiDocs("get-users"),
  }),
  getChannelInformation: defineRequest({
    name: "getChannelInformation",
    method: "GET",
    path: "/channels",
    input: GetChannelInformationInput,
    output: TwitchList(ChannelInformation),
    query: (input) => ({ broadcaster_id: input.broadcaster_id }),
    docsUrl: apiDocs("get-channel-information"),
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
    docsUrl: apiDocs("modify-channel-information"),
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
    docsUrl: apiDocs("create-custom-rewards"),
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
    docsUrl: apiDocs("update-custom-reward"),
  }),
  deleteCustomReward: defineRequest({
    name: "deleteCustomReward",
    method: "DELETE",
    path: "/channel_points/custom_rewards",
    scopes: ["channel:manage:redemptions"],
    input: DeleteCustomRewardInput,
    output: Schema.Void,
    query: (input) => ({ broadcaster_id: input.broadcaster_id, id: input.id }),
    docsUrl: apiDocs("delete-custom-reward"),
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
    docsUrl: apiDocs("get-custom-reward"),
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
    docsUrl: apiDocs("update-redemption-status"),
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
    docsUrl: apiDocs("send-chat-message"),
  }),
  createClip: defineRequest({
    name: "createClip",
    method: "POST",
    path: "/clips",
    scopes: ["clips:edit"],
    input: CreateClipInput,
    output: CreateClipOutput,
    query: (input) => ({ broadcaster_id: input.broadcaster_id, has_delay: input.has_delay }),
    docsUrl: apiDocs("create-clip"),
  }),
  startCommercial: defineRequest({
    name: "startCommercial",
    method: "POST",
    path: "/channels/commercial",
    scopes: ["channel:edit:commercial"],
    input: StartCommercialInput,
    output: StartCommercialOutput,
    body: (input) => jsonBody({ broadcaster_id: input.broadcaster_id, length: input.length }),
    docsUrl: apiDocs("start-commercial"),
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
    docsUrl: apiDocs("create-eventsub-subscription"),
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
    docsUrl: apiDocs("get-eventsub-subscriptions"),
  }),
  deleteEventSubSubscription: defineRequest({
    name: "deleteEventSubSubscription",
    method: "DELETE",
    path: "/eventsub/subscriptions",
    input: DeleteEventSubSubscriptionInput,
    output: Schema.Void,
    query: (input) => ({ id: input.id }),
    docsUrl: apiDocs("delete-eventsub-subscription"),
  }),
} as const;

export type Requests = typeof requests;
export type RequestName = keyof Requests;

export const isRequestName = (value: string): value is RequestName =>
  Object.hasOwn(requests, value);
