import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(
  new URL("../../../../examples/redeem-to-scene.ts", import.meta.url),
);
const helixPlan = fileURLToPath(new URL("./fixtures/helix-plan.ts", import.meta.url));
const topicOptions = fileURLToPath(new URL("./fixtures/topic-options.ts", import.meta.url));

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
            condition: { broadcaster_user_id: { slot: "broadcaster" } },
          },
        ],
        requests: [{ integration: "obs", slot: "main", request: "obs/*", scopes: [] }],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [],
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
        to_broadcaster_user_id: { slot: "broadcaster" },
      });
      expect(manifest.connections).toEqual([
        { integration: "twitch", slot: "bot", location: "either" },
        { integration: "twitch", slot: "broadcaster", location: "either" },
      ]);
    }),
  );
});
