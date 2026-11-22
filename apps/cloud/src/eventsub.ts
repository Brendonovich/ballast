import { Data, Effect } from "effect";

export class WebhookVerificationError extends Data.TaggedError("WebhookVerificationError")<{
  readonly cause: unknown;
}> {}

const decodeHex = (value: string): Uint8Array | undefined => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};

/** Twitch signs `message_id + message_timestamp + raw_body` with HMAC-SHA256. */
export const signedWebhookMessage = (
  messageId: string,
  timestamp: string,
  body: Uint8Array,
): Uint8Array => {
  const prefix = new TextEncoder().encode(messageId + timestamp);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return message;
};

export const verifyEventSubSignature = (
  secret: string,
  messageId: string,
  timestamp: string,
  body: Uint8Array,
  signature: string,
): Effect.Effect<boolean, WebhookVerificationError> => {
  const expected = signature.startsWith("sha256=")
    ? decodeHex(signature.slice("sha256=".length))
    : undefined;
  if (expected === undefined) return Effect.succeed(false);

  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        expected,
        signedWebhookMessage(messageId, timestamp, body),
      );
    },
    catch: (cause) => new WebhookVerificationError({ cause }),
  });
};

export const computeEventSubSignature = (
  secret: string,
  messageId: string,
  timestamp: string,
  body: Uint8Array,
): Effect.Effect<string, WebhookVerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        signedWebhookMessage(messageId, timestamp, body),
      );
      return `sha256=${Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
    },
    catch: (cause) => new WebhookVerificationError({ cause }),
  });
