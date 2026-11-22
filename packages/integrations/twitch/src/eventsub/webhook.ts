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
const WebhookBodyOnly = Schema.Union([
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

const decoder = new TextDecoder();

const deliveryFromMessage = (
  message: EventSubWebhookMessageType,
  input: VerifyWebhookInput,
): Effect.Effect<
  WebhookDelivery,
  Schema.SchemaError | UnknownSubscriptionType
> => {
  if (isWebhookMessageType(message, "webhook_callback_verification")) {
    return Effect.succeed({
      _tag: "verification" as const,
      challenge: message.payload.challenge,
      subscription: message.payload.subscription,
    });
  }
  if (isWebhookMessageType(message, "notification")) {
    return Effect.map(
      decodeNotification(message.payload.subscription.type, message.payload.event, {
        messageId: message.metadata.message_id,
        messageTimestamp: message.metadata.message_timestamp,
        receivedAt: new Date(input.now ?? Date.now()),
        subscription: message.payload.subscription,
      }),
      (notification): WebhookDelivery => ({ _tag: "notification", notification }),
    );
  }
  return Effect.succeed({
    _tag: "revocation" as const,
    subscription: message.payload.subscription,
  });
};

/**
 * Verify and decode one EventSub webhook delivery. Verification runs before
 * JSON parsing so unauthenticated bodies are never interpreted.
 */
export const handleWebhook = (
  input: VerifyWebhookInput,
): Effect.Effect<
  WebhookDelivery,
  WebhookVerificationError | Schema.SchemaError | UnknownSubscriptionType
> =>
  Effect.gen(function* () {
    yield* verifyWebhook(input);
    const body = typeof input.body === "string" ? input.body : decoder.decode(input.body);
    const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body);
    const envelope = Option.getOrUndefined(
      Schema.decodeUnknownOption(EventSubWebhookMessage)(json),
    );
    if (envelope !== undefined) return yield* deliveryFromMessage(envelope, input);

    const bodyOnly = yield* Schema.decodeUnknownEffect(WebhookBodyOnly)(json);
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
        notification: yield* decodeNotification(
          bodyOnly.subscription.type,
          bodyOnly.event,
          { messageId, messageTimestamp, receivedAt, subscription: bodyOnly.subscription },
        ),
      };
    }
    return { _tag: "revocation" as const, subscription: bodyOnly.subscription };
  });
