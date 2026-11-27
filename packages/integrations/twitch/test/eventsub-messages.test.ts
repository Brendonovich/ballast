import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildCondition,
  catalog,
  decodeSubscriptionEvent,
  subscriptions,
  subscriptionRequest,
  topics,
} from "../src/eventsub/subscriptions.ts";
import { topicKey } from "../src/protocol/topic.ts";
import { computeSignature } from "../src/eventsub/signature.ts";
import { decodeWebhook, handleWebhook } from "../src/eventsub/webhook.ts";

const subscription = (type: string, version: string, condition: Record<string, string>) => ({
  id: "sub-1",
  status: "enabled",
  type,
  version,
  condition,
  transport: { method: "webhook", callback: "https://example.com/webhooks/callback" },
  created_at: "2019-11-16T10:11:12.634234626Z",
  cost: 0,
});

describe("EventSub subscription catalog", () => {
  it("keeps the catalog and named topics in sync with the subscription table", () => {
    const types = Object.keys(subscriptions) as Array<keyof typeof subscriptions>;
    expect(Object.keys(catalog)).toHaveLength(types.length);
    expect(Object.keys(topics)).toHaveLength(types.length);
    for (const type of types) {
      const definition = subscriptions[type];
      expect(catalog[topicKey(type)]).toBe(definition);
      expect(topics[definition.name]).toBe(definition);
    }
  });

  it("builds flat Twitch conditions and drops unset optional keys", () => {
    expect(
      buildCondition("channel.channel_points_custom_reward_redemption.add", {
        broadcaster_user_id: "1337",
      }),
    ).toEqual({ broadcaster_user_id: "1337" });
    expect(
      subscriptionRequest("channel.chat.message", {
        broadcaster_user_id: "1337",
        user_id: "9001",
      }),
    ).toEqual({
      type: "channel.chat.message",
      version: 1,
      condition: { broadcaster_user_id: "1337", user_id: "9001" },
    });
  });

  it("rejects conditions that violate the type schema", () => {
    expect(() =>
      buildCondition("channel.follow", { broadcaster_user_id: "1337" } as {
        broadcaster_user_id: string;
        moderator_user_id: string;
      }),
    ).toThrow();
  });
});

describe("EventSub payload decoding", () => {
  it.effect("decodes a channel points redemption", () =>
    Effect.gen(function* () {
      const event = yield* decodeSubscriptionEvent(
        "channel.channel_points_custom_reward_redemption.add",
        {
          id: "17fa2df1-ad76-4804-bfa5-a40ef63efe63",
          broadcaster_user_id: "1337",
          broadcaster_user_login: "cool_user",
          broadcaster_user_name: "Cool_User",
          user_id: "9001",
          user_login: "cooler_user",
          user_name: "Cooler_User",
          user_input: "pogchamp",
          status: "unfulfilled",
          reward: {
            id: "92af127c-7326-4483-a52b-b0da0be61c01",
            title: "title",
            cost: 100,
            prompt: "reward prompt",
          },
          redeemed_at: "2020-07-15T17:16:03.17106713Z",
        },
      );
      expect(event.topic).toBe("twitch/channel.channel_points_custom_reward_redemption.add");
      if (event.type !== "channel.channel_points_custom_reward_redemption.add") return;
      expect(event.payload.reward.title).toBe("title");
      expect(event.payload.status).toBe("unfulfilled");
      expect(event.payload.redeemed_at).toBeInstanceOf(Date);
    }),
  );

  it.effect("fails on an unknown subscription type", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeSubscriptionEvent("channel.nope", {}));
      expect(error._tag).toBe("UnknownSubscriptionType");
    }),
  );
});

describe("EventSub webhook delivery", () => {
  it.effect("verifies and decodes a typed notification", () =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        metadata: {
          message_id: "msg-42",
          message_timestamp: timestamp,
          message_type: "notification",
          subscription_type: "channel.channel_points_custom_reward_redemption.add",
          subscription_version: "1",
        },
        payload: {
          subscription: subscription(
            "channel.channel_points_custom_reward_redemption.add",
            "1",
            { broadcaster_user_id: "1337" },
          ),
          event: {
            id: "redemption-1",
            broadcaster_user_id: "1337",
            broadcaster_user_login: "cool_user",
            broadcaster_user_name: "Cool_User",
            user_id: "9001",
            user_login: "cooler_user",
            user_name: "Cooler_User",
            user_input: "pogchamp",
            status: "unfulfilled",
            reward: {
              id: "reward-1",
              title: "title",
              cost: 100,
              prompt: "reward prompt",
            },
            redeemed_at: "2020-07-15T17:16:03.17106713Z",
          },
        },
      });
      const secret = "s3cret";
      const signature = yield* computeSignature({
        secret,
        messageId: "msg-42",
        timestamp,
        body,
      });

      const delivery = yield* handleWebhook({
        headers: {
          "Twitch-Eventsub-Message-Id": "msg-42",
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
          "Twitch-Eventsub-Message-Type": "notification",
        },
        body,
        secret,
      });

      expect(delivery._tag).toBe("notification");
      if (delivery._tag !== "notification") return;
      expect(delivery.notification.messageId).toBe("msg-42");
      if (delivery.notification.type !== "channel.channel_points_custom_reward_redemption.add") {
        return;
      }
      expect(delivery.notification.payload.reward.title).toBe("title");
    }),
  );

  it.effect("accepts a metadata-less CLI mock notification", () =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        subscription: subscription(
          "channel.channel_points_custom_reward_redemption.add",
          "1",
          { broadcaster_user_id: "1337" },
        ),
        event: {
          id: "redemption-cli",
          broadcaster_user_id: "1337",
          broadcaster_user_login: "testBroadcaster",
          broadcaster_user_name: "testBroadcaster",
          user_id: "9001",
          user_login: "testFromUser",
          user_name: "testFromUser",
          user_input: "Test Input From CLI",
          status: "unfulfilled",
          reward: {
            id: "reward-1",
            title: "Test Reward from CLI",
            cost: 250,
            prompt: "Redeem Your Test Reward from CLI",
          },
          redeemed_at: "2026-11-22T14:32:37.497224Z",
        },
      });
      const secret = "s3cret-secret";
      const messageId = "cli-message-1";
      const signature = yield* computeSignature({ secret, messageId, timestamp, body });
      const delivery = yield* handleWebhook({
        headers: {
          "Twitch-Eventsub-Message-Id": messageId,
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
          "Twitch-Eventsub-Message-Type": "notification",
          "Twitch-Eventsub-Subscription-Type":
            "channel.channel_points_custom_reward_redemption.add",
        },
        body,
        secret,
      });
      expect(delivery._tag).toBe("notification");
      if (delivery._tag !== "notification") return;
      expect(delivery.notification.messageId).toBe(messageId);
      if (delivery.notification.type !== "channel.channel_points_custom_reward_redemption.add") {
        return;
      }
      expect(delivery.notification.payload.reward.title).toBe("Test Reward from CLI");
    }),
  );

  it.effect("decodes a payload-agnostic notification without created_at", () =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        subscription: {
          id: "sub-new",
          status: "enabled",
          type: "channel.some_new_topic",
          version: "1",
          condition: { broadcaster_user_id: "1337" },
        },
        event: { whatever: true },
      });
      const secret = "s3cret";
      const messageId = "raw-message-1";
      const signature = yield* computeSignature({ secret, messageId, timestamp, body });
      const delivery = yield* decodeWebhook({
        headers: {
          "Twitch-Eventsub-Message-Id": messageId,
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
          "Twitch-Eventsub-Message-Type": "notification",
        },
        body,
        secret,
      });
      expect(delivery._tag).toBe("notification");
      if (delivery._tag !== "notification") return;
      expect(delivery.subscription.created_at).toBeUndefined();
      expect(delivery.event).toEqual({ whatever: true });
      expect(delivery.messageId).toBe(messageId);
    }),
  );

  it.effect("verifies a callback challenge", () =>
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        metadata: {
          message_id: "msg-verify",
          message_timestamp: timestamp,
          message_type: "webhook_callback_verification",
          subscription_type: "stream.online",
          subscription_version: "1",
        },
        payload: {
          subscription: subscription("stream.online", "1", { broadcaster_user_id: "1337" }),
          challenge: "challenge-123",
        },
      });
      const secret = "s3cret";
      const signature = yield* computeSignature({
        secret,
        messageId: "msg-verify",
        timestamp,
        body,
      });
      const delivery = yield* handleWebhook({
        headers: {
          "Twitch-Eventsub-Message-Id": "msg-verify",
          "Twitch-Eventsub-Message-Timestamp": timestamp,
          "Twitch-Eventsub-Message-Signature": signature,
        },
        body,
        secret,
      });
      expect(delivery._tag).toBe("verification");
      if (delivery._tag !== "verification") return;
      expect(delivery.challenge).toBe("challenge-123");
    }),
  );
});
