import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SubscriptionType } from "./subscriptions.ts";
import {
  UnknownSubscriptionType,
  isSubscriptionType,
  subscriptions,
  type NotificationFor,
} from "./subscriptions.ts";

export const EventSubTransport = Schema.Union([
  Schema.Struct({ method: Schema.Literal("webhook"), callback: Schema.String }),
  Schema.Struct({ method: Schema.Literal("websocket"), session_id: Schema.String }),
  Schema.Struct({ method: Schema.Literal("conduit"), conduit_id: Schema.String }),
]);
export type EventSubTransport = Schema.Schema.Type<typeof EventSubTransport>;

export const EventSubSubscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
  /** Twitch CLI mock deliveries omit this; real EventSub includes it. */
  created_at: Schema.optional(Schema.DateFromString),
  transport: Schema.optional(EventSubTransport),
  cost: Schema.optional(Schema.Number),
});
export type EventSubSubscription = Schema.Schema.Type<typeof EventSubSubscription>;

export const EventSubSession = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  connected_at: Schema.DateFromString,
  keepalive_timeout_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  reconnect_url: Schema.optional(Schema.NullOr(Schema.String)),
});
export type EventSubSession = Schema.Schema.Type<typeof EventSubSession>;

const metadata = <Type extends string>(type: Type) =>
  Schema.Struct({
    message_id: Schema.String,
    message_timestamp: Schema.DateFromString,
    message_type: Schema.Literal(type),
    subscription_type: Schema.optional(Schema.String),
    subscription_version: Schema.optional(Schema.String),
  });

export const EventSubWebSocketMessage = Schema.Union([
  Schema.Struct({
    metadata: metadata("session_welcome"),
    payload: Schema.Struct({ session: EventSubSession }),
  }),
  Schema.Struct({
    metadata: metadata("session_keepalive"),
    payload: Schema.Struct({}),
  }),
  Schema.Struct({
    metadata: metadata("notification"),
    payload: Schema.Struct({
      subscription: EventSubSubscription,
      event: Schema.Unknown,
    }),
  }),
  Schema.Struct({
    metadata: metadata("session_reconnect"),
    payload: Schema.Struct({ session: EventSubSession }),
  }),
  Schema.Struct({
    metadata: metadata("revocation"),
    payload: Schema.Struct({ subscription: EventSubSubscription }),
  }),
]);
export type EventSubWebSocketMessage = Schema.Schema.Type<typeof EventSubWebSocketMessage>;

export const EventSubWebhookMessage = Schema.Union([
  Schema.Struct({
    metadata: metadata("webhook_callback_verification"),
    payload: Schema.Struct({
      subscription: EventSubSubscription,
      challenge: Schema.String,
    }),
  }),
  Schema.Struct({
    metadata: metadata("notification"),
    payload: Schema.Struct({
      subscription: EventSubSubscription,
      event: Schema.Unknown,
    }),
  }),
  Schema.Struct({
    metadata: metadata("revocation"),
    payload: Schema.Struct({ subscription: EventSubSubscription }),
  }),
]);
export type EventSubWebhookMessage = Schema.Schema.Type<typeof EventSubWebhookMessage>;

export const decodeWebSocketMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EventSubWebSocketMessage),
);

export const parseWebSocketMessage = (raw: string) => decodeWebSocketMessage(raw);

export const decodeWebhookMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EventSubWebhookMessage),
);

export interface NotificationDetails {
  readonly messageId: string;
  /** The timestamp Twitch put in the message metadata. */
  readonly messageTimestamp: Date;
  /** When this process decoded the message. */
  readonly receivedAt: Date;
  readonly subscription: EventSubSubscription;
}

export type EventSubNotification = {
  [K in SubscriptionType]: NotificationFor<K> & NotificationDetails;
}[SubscriptionType];

export type EventSubWebSocketMessageType = EventSubWebSocketMessage["metadata"]["message_type"];

export const isWebSocketMessageType = <Type extends EventSubWebSocketMessageType>(
  message: EventSubWebSocketMessage,
  type: Type,
): message is Extract<
  EventSubWebSocketMessage,
  { readonly metadata: { readonly message_type: Type } }
> => message.metadata.message_type === type;

export const isWebhookMessageType = <
  Type extends EventSubWebhookMessage["metadata"]["message_type"],
>(
  message: EventSubWebhookMessage,
  type: Type,
): message is Extract<
  EventSubWebhookMessage,
  { readonly metadata: { readonly message_type: Type } }
> => message.metadata.message_type === type;

type NotificationDecoder = (
  event: unknown,
  details: NotificationDetails,
) => Effect.Effect<EventSubNotification, Schema.SchemaError>;

const notificationDecoders: Record<SubscriptionType, NotificationDecoder> = {
  "channel.channel_points_custom_reward_redemption.add": (event, details) =>
    Effect.map(
      subscriptions["channel.channel_points_custom_reward_redemption.add"].decode(event),
      (decoded) => ({
        ...decoded,
        version:
          subscriptions["channel.channel_points_custom_reward_redemption.add"].version,
        ...details,
      }),
    ),
  "channel.chat.message": (event, details) =>
    Effect.map(subscriptions["channel.chat.message"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["channel.chat.message"].version,
      ...details,
    })),
  "channel.follow": (event, details) =>
    Effect.map(subscriptions["channel.follow"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["channel.follow"].version,
      ...details,
    })),
  "channel.subscribe": (event, details) =>
    Effect.map(subscriptions["channel.subscribe"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["channel.subscribe"].version,
      ...details,
    })),
  "channel.cheer": (event, details) =>
    Effect.map(subscriptions["channel.cheer"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["channel.cheer"].version,
      ...details,
    })),
  "channel.raid": (event, details) =>
    Effect.map(subscriptions["channel.raid"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["channel.raid"].version,
      ...details,
    })),
  "stream.online": (event, details) =>
    Effect.map(subscriptions["stream.online"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["stream.online"].version,
      ...details,
    })),
  "stream.offline": (event, details) =>
    Effect.map(subscriptions["stream.offline"].decode(event), (decoded) => ({
      ...decoded,
      version: subscriptions["stream.offline"].version,
      ...details,
    })),
};

/**
 * Decode a notification's event payload once its subscription type is known.
 * Shared by the WebSocket and webhook transports.
 */
export const decodeNotification = (
  type: string,
  event: unknown,
  details: NotificationDetails,
): Effect.Effect<EventSubNotification, Schema.SchemaError | UnknownSubscriptionType> =>
  isSubscriptionType(type)
    ? notificationDecoders[type](event, details)
    : Effect.fail(new UnknownSubscriptionType({ type }));
