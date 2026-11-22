import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Twitch webhook signature verification, following
 * https://dev.twitch.tv/docs/eventsub/handling-webhook-events/#verifying-the-event-message.
 * The signed message is `message id + message timestamp + raw body`, signed
 * with HMAC-SHA256 and the subscription secret. Only Web Crypto and
 * `TextEncoder` are used, so this runs unchanged in a Cloudflare Worker.
 */

export const MESSAGE_ID_HEADER = "Twitch-Eventsub-Message-Id";
export const MESSAGE_TIMESTAMP_HEADER = "Twitch-Eventsub-Message-Timestamp";
export const MESSAGE_SIGNATURE_HEADER = "Twitch-Eventsub-Message-Signature";
export const MESSAGE_TYPE_HEADER = "Twitch-Eventsub-Message-Type";

/** Twitch rejects messages older than ten minutes; the clock is part of the protocol. */
export const DEFAULT_REPLAY_TOLERANCE_MS = 10 * 60 * 1000;

export type WebhookVerificationCode =
  | "missing-header"
  | "invalid-timestamp"
  | "timestamp-out-of-window"
  | "invalid-signature"
  | "crypto-unavailable";

export class WebhookVerificationError extends Schema.TaggedError<WebhookVerificationError>()(
  "WebhookVerificationError",
  {
    code: Schema.Literals([
      "missing-header",
      "invalid-timestamp",
      "timestamp-out-of-window",
      "invalid-signature",
      "crypto-unavailable",
    ]),
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason;
  }
}

export interface WebhookHeaders {
  readonly [name: string]: string | undefined;
}

/**
 * The Web Crypto implementation available in this runtime. Using the global's
 * own type keeps this compatible with Node, browsers, and Cloudflare Workers
 * without importing a DOM or Node declaration.
 */
export type SubtleCryptoLike = typeof globalThis.crypto.subtle;

export interface CryptoProvider {
  readonly subtle: SubtleCryptoLike;
}

export interface VerifyWebhookInput {
  readonly headers: WebhookHeaders;
  /** The raw body, before any JSON parsing. */
  readonly body: string | Uint8Array;
  readonly secret: string;
  /** Overridable for tests. */
  readonly now?: number;
  /** Defaults to ten minutes. */
  readonly toleranceMs?: number;
  /** Defaults to `globalThis.crypto`; Cloudflare Workers provide it. */
  readonly crypto?: CryptoProvider;
}

const encoder = new TextEncoder();

/** Read a Twitch header case-insensitively. */
export const getWebhookHeader = (headers: WebhookHeaders, name: string): string | undefined => {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
};

const toBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? encoder.encode(body) : body;

export const signedMessage = (
  messageId: string,
  timestamp: string,
  body: string | Uint8Array,
): Uint8Array => {
  const bodyBytes = toBytes(body);
  const prefix = encoder.encode(messageId + timestamp);
  const message = new Uint8Array(prefix.length + bodyBytes.length);
  message.set(prefix);
  message.set(bodyBytes, prefix.length);
  return message;
};

const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const decodeHex = (value: string): Uint8Array | undefined => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
};

const subtleCrypto = (crypto: CryptoProvider | undefined): SubtleCryptoLike | undefined =>
  crypto?.subtle ?? globalThis.crypto?.subtle;

const hmac = (
  secret: string,
  message: Uint8Array,
  crypto: CryptoProvider | undefined,
): Effect.Effect<Uint8Array, WebhookVerificationError> =>
  Effect.gen(function* () {
    const subtle = subtleCrypto(crypto);
    if (subtle === undefined) {
      return yield* new WebhookVerificationError({
        code: "crypto-unavailable",
        reason: "Web Crypto is not available in this runtime",
      });
    }
    const key = yield* Effect.tryPromise({
      try: () =>
        subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
        ]),
      catch: (cause) =>
        new WebhookVerificationError({ code: "crypto-unavailable", reason: String(cause) }),
    });
    const signature = yield* Effect.tryPromise({
      try: () => subtle.sign("HMAC", key, message),
      catch: (cause) =>
        new WebhookVerificationError({ code: "crypto-unavailable", reason: String(cause) }),
    });
    return new Uint8Array(signature);
  });

/** Compute the `sha256=<hex>` signature Twitch sends in its header. */
export const computeSignature = (input: {
  readonly secret: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly body: string | Uint8Array;
  readonly crypto?: CryptoProvider;
}): Effect.Effect<string, WebhookVerificationError> =>
  Effect.map(
    hmac(input.secret, signedMessage(input.messageId, input.timestamp, input.body), input.crypto),
    (signature) => `sha256=${toHex(signature)}`,
  );

/**
 * Verify a Twitch EventSub webhook request. Checks the required headers, the
 * ten-minute replay window, and the HMAC of the raw body.
 */
export const verifyWebhook = (input: VerifyWebhookInput): Effect.Effect<void, WebhookVerificationError> =>
  Effect.gen(function* () {
    const messageId = getWebhookHeader(input.headers, MESSAGE_ID_HEADER);
    const timestamp = getWebhookHeader(input.headers, MESSAGE_TIMESTAMP_HEADER);
    const signature = getWebhookHeader(input.headers, MESSAGE_SIGNATURE_HEADER);
    if (messageId === undefined || messageId.length === 0) {
      return yield* new WebhookVerificationError({
        code: "missing-header",
        reason: `Missing ${MESSAGE_ID_HEADER} header`,
      });
    }
    if (timestamp === undefined || timestamp.length === 0) {
      return yield* new WebhookVerificationError({
        code: "missing-header",
        reason: `Missing ${MESSAGE_TIMESTAMP_HEADER} header`,
      });
    }
    if (signature === undefined || signature.length === 0) {
      return yield* new WebhookVerificationError({
        code: "missing-header",
        reason: `Missing ${MESSAGE_SIGNATURE_HEADER} header`,
      });
    }

    const signedAt = Date.parse(timestamp);
    if (Number.isNaN(signedAt)) {
      return yield* new WebhookVerificationError({
        code: "invalid-timestamp",
        reason: `${MESSAGE_TIMESTAMP_HEADER} is not an RFC 3339 timestamp`,
      });
    }
    const tolerance = input.toleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
    const now = input.now ?? Date.now();
    if (Math.abs(now - signedAt) > tolerance) {
      return yield* new WebhookVerificationError({
        code: "timestamp-out-of-window",
        reason: "EventSub message is outside the ten-minute replay window",
      });
    }

    if (!signature.startsWith("sha256=")) {
      return yield* new WebhookVerificationError({
        code: "invalid-signature",
        reason: `${MESSAGE_SIGNATURE_HEADER} must start with sha256=`,
      });
    }
    const provided = decodeHex(signature.slice("sha256=".length));
    if (provided === undefined) {
      return yield* new WebhookVerificationError({
        code: "invalid-signature",
        reason: `${MESSAGE_SIGNATURE_HEADER} is not valid hex`,
      });
    }

    const expected = yield* hmac(
      input.secret,
      signedMessage(messageId, timestamp, input.body),
      input.crypto,
    );
    if (!equalBytes(expected, provided)) {
      return yield* new WebhookVerificationError({
        code: "invalid-signature",
        reason: "EventSub signature does not match the request body",
      });
    }
  });
