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
import { decodeWebhook, decodeWebhookBody, handleWebhook } from "../src/eventsub/webhook.ts";

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
    expect(subscriptions["channel.chat.message"].cost).toBe(1);
    expect(subscriptions["channel.chat.message"].conditionRoles).toEqual({
      broadcaster_user_id: "target",
      user_id: "self",
    });
    expect(subscriptions["channel.follow"].conditionRoles).toEqual({
      broadcaster_user_id: "target",
      moderator_user_id: "self",
    });
    expect(
      subscriptions["channel.channel_points_custom_reward_redemption.add"].conditionRoles,
    ).toEqual({ broadcaster_user_id: "self", reward_id: "any" });
  });

  it("keeps the catalog and named topics in sync with the subscription table", () => {
    const types = Object.keys(subscriptions) as Array<keyof typeof subscriptions>;
    expect(Object.keys(catalog)).toHaveLength(types.length);
    expect(Object.keys(topics)).toHaveLength(types.length);
    for (const type of types) {
      const definition = subscriptions[type];
      expect(catalog[topicKey(type)]).toBe(definition);
      expect(topics[definition.name]).toBe(definition);
    }
    expect(subscriptions["channel.hype_train.begin"].version).toBe(2);
    expect(subscriptions["channel.hype_train.progress"].cost).toBe(2);
    expect(subscriptions["channel.update"].version).toBe(2);
    expect(subscriptions["channel.update"].cost).toBe(2);
    expect(subscriptions["channel.poll.begin"].scopes).toEqual(["channel:read:polls"]);
    expect(subscriptions["channel.prediction.lock"].scopes).toEqual([
      "channel:read:predictions",
    ]);
    expect(subscriptions["channel.subscription.gift"].scopes).toEqual([
      "channel:read:subscriptions",
    ]);
    expect(subscriptions["channel.channel_points_custom_reward.add"].scopes).toEqual([
      "channel:read:redemptions",
    ]);
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

  it.effect("decodes poll, prediction, hype train, reward and subscription events", () =>
    Effect.gen(function* () {
      const broadcaster = {
        broadcaster_user_id: "1337",
        broadcaster_user_login: "cool_user",
        broadcaster_user_name: "Cool_User",
      };
      const user = {
        user_id: "9001",
        user_login: "cooler_user",
        user_name: "Cooler_User",
      };

      const pollBegin = yield* decodeSubscriptionEvent("channel.poll.begin", {
        id: "poll-1",
        ...broadcaster,
        title: "Best game?",
        choices: [
          { id: "choice-1", title: "A", votes: 0, bits_votes: 0, channel_points_votes: 0 },
        ],
        bits_voting: { is_enabled: false, amount_per_vote: 0 },
        channel_points_voting: { is_enabled: true, amount_per_vote: 1 },
        started_at: "2020-07-15T17:16:03.17106713Z",
        ends_at: "2020-07-15T17:21:03.17106713Z",
      });
      if (pollBegin.type !== "channel.poll.begin") return;
      expect(pollBegin.payload.choices[0]?.title).toBe("A");
      expect(pollBegin.payload.started_at).toBeInstanceOf(Date);

      const pollEnd = yield* decodeSubscriptionEvent("channel.poll.end", {
        id: "poll-1",
        ...broadcaster,
        title: "Best game?",
        choices: [
          { id: "choice-1", title: "A", votes: 12, bits_votes: 0, channel_points_votes: 12 },
        ],
        bits_voting: { is_enabled: false, amount_per_vote: 0 },
        channel_points_voting: { is_enabled: true, amount_per_vote: 1 },
        status: "completed",
        started_at: "2020-07-15T17:16:03.17106713Z",
        ended_at: "2020-07-15T17:21:03.17106713Z",
      });
      if (pollEnd.type !== "channel.poll.end") return;
      expect(pollEnd.payload.status).toBe("completed");
      expect(pollEnd.payload.choices[0]?.votes).toBe(12);

      const predictionBegin = yield* decodeSubscriptionEvent("channel.prediction.begin", {
        id: "prediction-1",
        ...broadcaster,
        title: "Will it rain?",
        outcomes: [
          {
            id: "outcome-1",
            title: "Yes",
            color: "blue",
            users: 0,
            channel_points: 0,
            top_predictors: [],
          },
        ],
        started_at: "2020-07-15T17:16:03.17106713Z",
        locks_at: "2020-07-15T17:20:03.17106713Z",
      });
      if (predictionBegin.type !== "channel.prediction.begin") return;
      expect(predictionBegin.payload.outcomes[0]?.color).toBe("blue");

      const predictionEnd = yield* decodeSubscriptionEvent("channel.prediction.end", {
        id: "prediction-1",
        ...broadcaster,
        title: "Will it rain?",
        winning_outcome_id: "outcome-1",
        outcomes: [
          {
            id: "outcome-1",
            title: "Yes",
            color: "blue",
            users: 3,
            channel_points: 300,
            top_predictors: [
              {
                user_id: "9001",
                user_login: "cooler_user",
                user_name: "Cooler_User",
                channel_points_won: 900,
                channel_points_used: 100,
              },
            ],
          },
        ],
        status: "resolved",
        started_at: "2020-07-15T17:16:03.17106713Z",
        locks_at: "2020-07-15T17:20:03.17106713Z",
        ended_at: "2020-07-15T17:21:03.17106713Z",
      });
      if (predictionEnd.type !== "channel.prediction.end") return;
      expect(predictionEnd.payload.winning_outcome_id).toBe("outcome-1");
      expect(predictionEnd.payload.outcomes[0]?.top_predictors[0]?.channel_points_won).toBe(
        900,
      );

      const hypeTrain = yield* decodeSubscriptionEvent("channel.hype_train.progress", {
        id: "hype-train-1",
        ...broadcaster,
        total: 100,
        progress: 100,
        goal: 500,
        top_contributions: [
          { user_id: "9001", user_login: "cooler_user", user_name: "Cooler_User", type: "bits", total: 100 },
        ],
        level: 1,
        shared_train_participants: null,
        is_shared_train: false,
        started_at: "2020-07-15T17:16:03.17106713Z",
        expires_at: "2020-07-15T17:26:03.17106713Z",
        type: "regular",
      });
      if (hypeTrain.type !== "channel.hype_train.progress") return;
      expect(hypeTrain.payload.level).toBe(1);
      expect(hypeTrain.payload.top_contributions[0]?.type).toBe("bits");

      const channelUpdate = yield* decodeSubscriptionEvent("channel.update", {
        ...broadcaster,
        title: "Building things",
        language: "en",
        category_id: "509658",
        category_name: "Just Chatting",
        content_classification_labels: [],
      });
      if (channelUpdate.type !== "channel.update") return;
      expect(channelUpdate.payload.category_name).toBe("Just Chatting");

      const subscriptionGift = yield* decodeSubscriptionEvent("channel.subscription.gift", {
        user_id: null,
        user_login: null,
        user_name: null,
        ...broadcaster,
        total: 5,
        tier: "1000",
        cumulative_total: null,
        is_anonymous: true,
      });
      if (subscriptionGift.type !== "channel.subscription.gift") return;
      expect(subscriptionGift.payload.is_anonymous).toBe(true);

      const subscriptionMessage = yield* decodeSubscriptionEvent(
        "channel.subscription.message",
        {
          ...user,
          ...broadcaster,
          tier: "2000",
          message: { text: "12 months!", emotes: [] },
          cumulative_months: 12,
          streak_months: null,
          duration_months: 1,
        },
      );
      if (subscriptionMessage.type !== "channel.subscription.message") return;
      expect(subscriptionMessage.payload.message.text).toBe("12 months!");
      expect(subscriptionMessage.payload.cumulative_months).toBe(12);

      const subscriptionEnd = yield* decodeSubscriptionEvent("channel.subscription.end", {
        ...user,
        ...broadcaster,
        tier: "3000",
        is_gift: false,
      });
      if (subscriptionEnd.type !== "channel.subscription.end") return;
      expect(subscriptionEnd.payload.tier).toBe("3000");

      const redemptionUpdate = yield* decodeSubscriptionEvent(
        "channel.channel_points_custom_reward_redemption.update",
        {
          id: "redemption-1",
          ...broadcaster,
          ...user,
          user_input: "pogchamp",
          status: "fulfilled",
          reward: { id: "reward-1", title: "Hydrate", cost: 250, prompt: "Drink water" },
          redeemed_at: "2020-07-15T17:16:03.17106713Z",
        },
      );
      if (redemptionUpdate.type !== "channel.channel_points_custom_reward_redemption.update") {
        return;
      }
      expect(redemptionUpdate.payload.status).toBe("fulfilled");

      const rewardUpdate = yield* decodeSubscriptionEvent(
        "channel.channel_points_custom_reward.update",
        {
          id: "reward-1",
          ...broadcaster,
          is_enabled: true,
          is_paused: false,
          is_in_stock: true,
          title: "Hydrate",
          cost: 250,
          prompt: "Drink water",
          is_user_input_required: false,
          should_redemptions_skip_request_queue: false,
          max_per_stream: { is_enabled: false, value: 0 },
          max_per_user_per_stream: { is_enabled: false, value: 0 },
          background_color: "#00E5CB",
          image: null,
          default_image: {
            url_1x: "https://example.com/1x.png",
            url_2x: "https://example.com/2x.png",
            url_4x: "https://example.com/4x.png",
          },
          global_cooldown: { is_enabled: false, seconds: 0 },
          cooldown_expires_at: null,
          redemptions_redeemed_current_stream: null,
        },
      );
      if (rewardUpdate.type !== "channel.channel_points_custom_reward.update") return;
      expect(rewardUpdate.payload.title).toBe("Hydrate");
      expect(rewardUpdate.payload.image).toBeNull();
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

  it.effect("exports the body-only parser", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeWebhookBody({
        subscription: {
          id: "sub-body",
          status: "enabled",
          type: "stream.online",
          version: "1",
          condition: { broadcaster_user_id: "1337" },
        },
        event: { id: "9001" },
      });
      expect("event" in parsed).toBe(true);
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
