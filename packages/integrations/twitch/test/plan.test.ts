import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(
  new URL("../../../../examples/redeem-to-scene.ts", import.meta.url),
);
const helixPlan = fileURLToPath(new URL("./fixtures/helix-plan.ts", import.meta.url));
const topicOptions = fileURLToPath(new URL("./fixtures/topic-options.ts", import.meta.url));
const extendedTopics = fileURLToPath(new URL("./fixtures/extended-topics.ts", import.meta.url));

describe("plan Twitch scripts", () => {
  it.effect("records the redeem-to-scene manifest", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        project: { id: "redeem-to-scene", entry: "redeem-to-scene.ts" },
        params: [
          { key: "rewardTitle", type: "string" },
          {
            key: "scene",
            type: "string",
            options: { integration: "obs", slot: "main", source: "scenes" },
          },
        ],
        connections: [
          { integration: "obs", slot: "main", location: "local" },
          { integration: "twitch", slot: "broadcaster", location: "either" },
        ],
        topics: [
          {
            integration: "twitch",
            slot: "broadcaster",
            topic: "twitch/channel.channel_points_custom_reward_redemption.add",
            name: "redemption",
            scopes: ["channel:read:redemptions"],
            onStale: "drop",
            maxAgeMs: 60_000,
            history: { maxEntries: 1000, retentionMs: 7 * 24 * 60 * 60_000 },
            schemaFingerprint: expect.any(String),
            condition: { broadcaster_user_id: { slot: "broadcaster" } },
          },
        ],
        requests: [{ integration: "obs", slot: "main", request: "obs/*", scopes: [] }],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [],
        artifacts: [],
        stores: [],
        databases: [],
      });
    }),
  );

  it.effect("records a Helix request with its OAuth scopes", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(helixPlan);
      expect(manifest.requests).toEqual([
        {
          integration: "twitch",
          slot: "broadcaster",
          request: "helix/sendChatMessage",
          scopes: ["user:write:chat"],
        },
      ]);
    }),
  );

  it.effect("records the expanded EventSub topics and Helix requests", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(extendedTopics);
      const topics = new Map(
        manifest.topics.map((topic) => [topic.topic, topic]),
      );

      expect([...topics.keys()].sort()).toEqual([
        "twitch/channel.channel_points_custom_reward_redemption.update",
        "twitch/channel.hype_train.begin",
        "twitch/channel.poll.end",
        "twitch/channel.prediction.lock",
        "twitch/channel.subscription.gift",
        "twitch/channel.update",
      ]);
      expect(
        topics.get("twitch/channel.channel_points_custom_reward_redemption.update")?.condition,
      ).toEqual({
        broadcaster_user_id: { slot: "broadcaster" },
        reward_id: "reward-1",
      });
      expect(topics.get("twitch/channel.hype_train.begin")?.scopes).toEqual([
        "channel:read:hype_train",
      ]);
      expect(topics.get("twitch/channel.poll.end")?.scopes).toEqual(["channel:read:polls"]);
      expect(topics.get("twitch/channel.prediction.lock")?.scopes).toEqual([
        "channel:read:predictions",
      ]);
      expect(topics.get("twitch/channel.update")?.scopes).toEqual([]);
      expect(topics.get("twitch/channel.subscription.gift")?.scopes).toEqual([
        "channel:read:subscriptions",
      ]);

      expect(
        [...manifest.requests].sort((a, b) => a.request.localeCompare(b.request)),
      ).toEqual([
        {
          integration: "twitch",
          slot: "broadcaster",
          request: "helix/banUser",
          scopes: ["moderator:manage:banned_users"],
        },
        {
          integration: "twitch",
          slot: "broadcaster",
          request: "helix/endPoll",
          scopes: ["channel:manage:polls"],
        },
        {
          integration: "twitch",
          slot: "broadcaster",
          request: "helix/sendAnnouncement",
          scopes: ["moderator:manage:announcements"],
        },
      ]);
    }),
  );

  it.effect("turns per-topic options into condition templates", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(topicOptions);
      const byTopic = new Map(
        manifest.topics.map((topic) => [topic.slot + ":" + topic.topic, topic]),
      );

      const redemptions = manifest.topics.filter(
        (topic) =>
          topic.topic ===
          "twitch/channel.channel_points_custom_reward_redemption.add",
      );
      expect(
        redemptions.map((topic) => topic.condition?.["reward_id"]).sort(),
      ).toEqual(["reward-1", "reward-2"]);
      expect(redemptions[0]?.condition?.["broadcaster_user_id"]).toEqual({
        slot: "broadcaster",
      });
      expect(byTopic.get("bot:twitch/channel.chat.message")?.condition).toEqual({
        broadcaster_user_id: { slot: "broadcaster" },
        user_id: { slot: "bot" },
      });
      expect(byTopic.get("broadcaster:twitch/channel.raid")?.condition).toEqual({
        from_broadcaster_user_id: { slot: "broadcaster" },
      });
      expect(manifest.connections).toEqual([
        { integration: "twitch", slot: "bot", location: "either" },
        { integration: "twitch", slot: "broadcaster", location: "either" },
      ]);
    }),
  );
});
