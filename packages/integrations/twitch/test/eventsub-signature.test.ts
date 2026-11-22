import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { computeSignature, verifyWebhook } from "../src/eventsub/signature.ts";

const secret = "s3cret";
const body = '{"challenge":"abc"}';
const messageId = "msg-1";
const timestamp = "2026-11-22T00:00:00.000Z";
const now = Date.parse(timestamp);
const knownSignature = "sha256=6ba0cb9f97d26d1f9f3086287d00484e3ed84c6834ac2a433f1020cdb65b8a1f";

const headers = (signature = knownSignature) => ({
  "Twitch-Eventsub-Message-Id": messageId,
  "Twitch-Eventsub-Message-Timestamp": timestamp,
  "Twitch-Eventsub-Message-Signature": signature,
  "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
});

describe("EventSub webhook signatures", () => {
  it.effect("computes Twitch's HMAC-SHA256 scheme", () =>
    Effect.gen(function* () {
      const signature = yield* computeSignature({ secret, messageId, timestamp, body });
      expect(signature).toBe(knownSignature);
    }),
  );

  it.effect("accepts a correctly signed message inside the replay window", () =>
    verifyWebhook({ headers: headers(), body, secret, now }),
  );

  it.effect("rejects a message older than ten minutes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body, secret, now: now + 10 * 60 * 1000 + 1 }),
      );
      expect(error.code).toBe("timestamp-out-of-window");
    }),
  );

  it.effect("rejects a tampered body", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        verifyWebhook({ headers: headers(), body: '{"challenge":"abd"}', secret, now }),
      );
      expect(error.code).toBe("invalid-signature");
    }),
  );

  it.effect("rejects a missing signature header", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        verifyWebhook({
          headers: {
            "Twitch-Eventsub-Message-Id": messageId,
            "Twitch-Eventsub-Message-Timestamp": timestamp,
          },
          body,
          secret,
          now,
        }),
      );
      expect(error.code).toBe("missing-header");
    }),
  );

  it.effect("reads headers case-insensitively", () =>
    verifyWebhook({
      headers: {
        "twitch-eventsub-message-id": messageId,
        "twitch-eventsub-message-timestamp": timestamp,
        "twitch-eventsub-message-signature": knownSignature,
      },
      body,
      secret,
      now,
    }),
  );
});
