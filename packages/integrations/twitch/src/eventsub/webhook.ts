import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EventSubNotification } from "./messages.ts";
import {
  EventSubSubscription,
  EventSubWebhookMessage,
  decodeNotification,
  isWebhookMessageType,
} from "./messages.ts";
import type { EventSubWebhookMessage as EventSubWebhookMessageType } from "./messages.ts";
import type { UnknownSubscriptionType } from "./subscriptions.ts";
import {
  MESSAGE_ID_HEADER,
  MESSAGE_TIMESTAMP_HEADER,
  getWebhookHeader,
  verifyWebhook,
  type VerifyWebhookInput,
  type WebhookVerificationError,
} from "./signature.ts";

/** A delivery whose event payload has deliberately not been typed yet. */
export type RawWebhookDelivery =
  | {
      readonly _tag: "verification";
      readonly challenge: string;
      readonly subscription: EventSubSubscription;
    }
  | {
      readonly _tag: "notification";
      readonly messageId: string;
      readonly messageTimestamp: Date;
      readonly receivedAt: Date;
      readonly subscription: EventSubSubscription;
      /** The raw EventSub event. Decode it against the subscription registry. */
      readonly event: unknown;
    }
  | {
      readonly _tag: "revocation";
      readonly subscription: EventSubSubscription;
    };

export type WebhookDelivery =
  | {
      readonly _tag: "verification";
      readonly challenge: string;
      readonly subscription: EventSubSubscription;
    }
  | {
      readonly _tag: "notification";
      readonly notification: EventSubNotification;
    }
  | {
      readonly _tag: "revocation";
      readonly subscription: EventSubSubscription;
    };

/**
 * A payload with no metadata envelope. Twitch's own CLI (1.1.x) sends these
 * when forwarding a mock event, even though real EventSub deliveries include
 * metadata. Accepting both keeps the same handler useful for local testing.
 */
export const WebhookBody = Schema.Union([
  Schema.Struct({
    subscription: EventSubSubscription,
    challenge: Schema.String,
  }),
  Schema.Struct({
    subscription: EventSubSubscription,
    event: Schema.Unknown,
  }),
  Schema.Struct({ subscription: EventSubSubscription }),
]);
export type WebhookBody = Schema.Schema.Type<typeof WebhookBody>;

export const decodeWebhookBody = (
  value: unknown,
): Effect.Effect<WebhookBody, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(WebhookBody)(value);

const decoder = new TextDecoder();

const notificationDelivery = (
  message: EventSubWebhookMessageType,
  input: VerifyWebhookInput,
): RawWebhookDelivery => {
  if (isWebhookMessageType(message, "webhook_callback_verification")) {
    return {
      _tag: "verification",
      challenge: message.payload.challenge,
      subscription: message.payload.subscription,
    };
  }
  if (isWebhookMessageType(message, "notification")) {
    return {
      _tag: "notification",
      messageId: message.metadata.message_id,
      messageTimestamp: message.metadata.message_timestamp,
      receivedAt: new Date(input.now ?? Date.now()),
      subscription: message.payload.subscription,
      event: message.payload.event,
    };
  }
  return {
    _tag: "revocation",
    subscription: message.payload.subscription,
  };
};

/**
 * Verify and decode one EventSub webhook delivery without decoding its event
 * payload. This is the decoder for a gateway that relays unknown or newer
 * subscription types; use {@link handleWebhook} when the payload type is
 * known and typed.
 */
export const decodeWebhook = (
  input: VerifyWebhookInput,
): Effect.Effect<RawWebhookDelivery, WebhookVerificationError | Schema.SchemaError> =>
  Effect.gen(function* () {
    yield* verifyWebhook(input);
    const body = typeof input.body === "string" ? input.body : decoder.decode(input.body);
    const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
    const envelope = Option.getOrUndefined(
      Schema.decodeUnknownOption(EventSubWebhookMessage)(json),
    );
    if (envelope !== undefined) return notificationDelivery(envelope, input);

    const bodyOnly = yield* decodeWebhookBody(json);
    const messageId =
      getWebhookHeader(input.headers, MESSAGE_ID_HEADER) ?? bodyOnly.subscription.id;
    const receivedAt = new Date(input.now ?? Date.now());
    const rawTimestamp = getWebhookHeader(input.headers, MESSAGE_TIMESTAMP_HEADER);
    const parsedTimestamp = rawTimestamp === undefined ? Number.NaN : Date.parse(rawTimestamp);
    const messageTimestamp = Number.isNaN(parsedTimestamp) ? receivedAt : new Date(parsedTimestamp);
    if ("challenge" in bodyOnly) {
      return {
        _tag: "verification" as const,
        challenge: bodyOnly.challenge,
        subscription: bodyOnly.subscription,
      };
    }
    if ("event" in bodyOnly) {
      return {
        _tag: "notification" as const,
        messageId,
        messageTimestamp,
        receivedAt,
        subscription: bodyOnly.subscription,
        event: bodyOnly.event,
      };
    }
    return { _tag: "revocation" as const, subscription: bodyOnly.subscription };
  });

/**
 * Verify and decode one EventSub webhook delivery, including its typed event.
 * Unknown subscription types fail with {@link UnknownSubscriptionType}; the
 * gateway should use {@link decodeWebhook} when it relays payloads as-is.
 */
export const handleWebhook = (
  input: VerifyWebhookInput,
): Effect.Effect<
  WebhookDelivery,
  WebhookVerificationError | Schema.SchemaError | UnknownSubscriptionType
> =>
  Effect.gen(function* () {
    const delivery = yield* decodeWebhook(input);
    if (delivery._tag === "verification" || delivery._tag === "revocation") return delivery;
    const notification = yield* decodeNotification(
      delivery.subscription.type,
      delivery.event,
      {
        messageId: delivery.messageId,
        messageTimestamp: delivery.messageTimestamp,
        receivedAt: delivery.receivedAt,
        subscription: delivery.subscription,
      },
    );
    return { _tag: "notification" as const, notification };
  });
