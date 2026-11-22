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
import { computeSignature } from "../src/eventsub/signature.ts";
import { handleWebhook } from "../src/eventsub/webhook.ts";

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
  it("exposes friendly names, versions, scopes and conditions", () => {
    expect(subscriptions["channel.follow"].version).toBe(2);
    expect(subscriptions["channel.channel_points_custom_reward_redemption.add"].scopes).toEqual([
      "channel:read:redemptions",
    ]);
    expect(topics.ChannelPointsRedemption.name).toBe("ChannelPointsRedemption");
    expect(topics.ChatMessage.type).toBe("channel.chat.message");
    expect(catalog["twitch/channel.cheer"].name).toBe("Cheer");
    expect(catalog["twitch/stream.online"].version).toBe(1);
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

  it.effect("decodes a chat message with fragments and badges", () =>
    Effect.gen(function* () {
      const event = yield* decodeSubscriptionEvent("channel.chat.message", {
        broadcaster_user_id: "1971641",
        broadcaster_user_login: "streamer",
        broadcaster_user_name: "streamer",
        chatter_user_id: "4145994",
        chatter_user_login: "viewer32",
        chatter_user_name: "viewer32",
        message_id: "cc106a89-1814-919d-454c-f4f2f970aae7",
        message: {
          text: "Hi chat",
          fragments: [
            {
              type: "text",
              text: "Hi chat",
              cheermote: null,
              emote: null,
              mention: null,
            },
          ],
        },
        color: "#00FF7F",
        badges: [{ set_id: "moderator", id: "1", info: "" }],
        message_type: "text",
        cheer: null,
        reply: null,
        channel_points_custom_reward_id: null,
        source_broadcaster_user_id: null,
        source_broadcaster_user_login: null,
        source_broadcaster_user_name: null,
        source_message_id: null,
        source_badges: null,
      });
      if (event.type !== "channel.chat.message") return;
      expect(event.payload.message.fragments[0]?.text).toBe("Hi chat");
      expect(event.payload.badges[0]?.set_id).toBe("moderator");
    }),
  );

  it.effect("decodes follow, subscribe, cheer, raid and stream events", () =>
    Effect.gen(function* () {
      const follow = yield* decodeSubscriptionEvent("channel.follow", {
        user_id: "1234",
        user_login: "cool_user",
        user_name: "Cool_User",
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cooler_user",
        broadcaster_user_name: "Cooler_User",
        followed_at: "2020-07-15T18:16:11.17106713Z",
      });
      if (follow.type !== "channel.follow") return;
      expect(follow.payload.user_login).toBe("cool_user");

      const subscribe = yield* decodeSubscriptionEvent("channel.subscribe", {
        user_id: "1234",
        user_login: "cool_user",
        user_name: "Cool_User",
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cooler_user",
        broadcaster_user_name: "Cooler_User",
        tier: "1000",
        is_gift: false,
      });
      if (subscribe.type !== "channel.subscribe") return;
      expect(subscribe.payload.tier).toBe("1000");

      const cheer = yield* decodeSubscriptionEvent("channel.cheer", {
        is_anonymous: false,
        user_id: "1234",
        user_login: "cool_user",
        user_name: "Cool_User",
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cooler_user",
        broadcaster_user_name: "Cooler_User",
        message: "pogchamp",
        bits: 1000,
      });
      if (cheer.type !== "channel.cheer") return;
      expect(cheer.payload.bits).toBe(1000);

      const raid = yield* decodeSubscriptionEvent("channel.raid", {
        from_broadcaster_user_id: "1234",
        from_broadcaster_user_login: "cool_user",
        from_broadcaster_user_name: "Cool_User",
        to_broadcaster_user_id: "1337",
        to_broadcaster_user_login: "cooler_user",
        to_broadcaster_user_name: "Cooler_User",
        viewers: 9001,
      });
      if (raid.type !== "channel.raid") return;
      expect(raid.payload.viewers).toBe(9001);

      const online = yield* decodeSubscriptionEvent("stream.online", {
        id: "9001",
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cool_user",
        broadcaster_user_name: "Cool_User",
        type: "live",
        started_at: "2020-10-11T10:11:12.123Z",
      });
      if (online.type !== "stream.online") return;
      expect(online.payload.started_at).toBeInstanceOf(Date);

      const offline = yield* decodeSubscriptionEvent("stream.offline", {
        id: "9001",
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cool_user",
        broadcaster_user_name: "Cool_User",
      });
      if (offline.type !== "stream.offline") return;
      expect(offline.payload.broadcaster_user_id).toBe("1337");
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
