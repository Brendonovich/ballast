import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RuntimeSession } from "../src/runtime-session.ts";
import {
  EventLog,
  EventLogLive,
  EventRouter,
  EventRouterLive,
} from "../src/service/telemetry.ts";

const RouterLive = EventRouterLive.pipe(Layer.provideMerge(EventLogLive));

describe("service telemetry", () => {
  it.effect("stores decoded payload Dates and bytes as JSON", () =>
    Effect.gen(function* () {
      const events = yield* EventLog;
      const redeemedAt = new Date("2026-01-02T03:04:05.000Z");
      yield* events.record({
        direction: "inbound",
        integration: "twitch",
        topic: "twitch/channel.channel_points_custom_reward_redemption.add",
        payload: {
          id: "redemption-1",
          redeemed_at: redeemedAt,
          nested: { when: redeemedAt },
          bytes: new Uint8Array([1, 2, 3]),
        },
      });

      const [entry] = yield* events.entries;
      expect(entry?.payload).toEqual({
        id: "redemption-1",
        redeemed_at: "2026-01-02T03:04:05.000Z",
        nested: { when: "2026-01-02T03:04:05.000Z" },
        bytes: [1, 2, 3],
      });
    }).pipe(Effect.provide(EventLogLive)),
  );

  it.effect("buffers a relayed event until the generation registers", () =>
    Effect.gen(function* () {
      const router = yield* EventRouter;
      const key = "twitch/broadcaster/twitch/channel.channel_points_custom_reward_redemption.add";
      const delivered: Array<unknown> = [];
      const session: RuntimeSession = {
        generation: 1,
        subscriptions: new Set([key]),
        ready: Effect.void,
        deliver: (_key, payload) => {
          delivered.push(payload);
        },
        deliverTimer: () => undefined,
        close: Effect.void,
      };

      yield* router.expectSubscriptions({
        projectId: "project",
        scriptId: "script",
        subscriptions: [key],
      });
      yield* router.publishInbound({
        integration: "twitch",
        slot: "broadcaster",
        topic: "twitch/channel.channel_points_custom_reward_redemption.add",
        payload: { id: "redemption-1" },
      });
      expect(delivered).toEqual([]);

      yield* router.register({ projectId: "project", scriptId: "script", session });
      expect(delivered).toEqual([{ id: "redemption-1" }]);
    }).pipe(Effect.provide(RouterLive)),
  );

  it.effect("still drops an event that no generation expects", () =>
    Effect.gen(function* () {
      const router = yield* EventRouter;
      const events = yield* EventLog;

      yield* router.publishInbound({
        integration: "twitch",
        slot: "broadcaster",
        topic: "twitch/channel.channel_points_custom_reward_redemption.add",
        payload: { id: "redemption-2" },
      });

      const [entry] = yield* events.entries;
      expect(entry?.dropped).toBe(true);
    }).pipe(Effect.provide(RouterLive)),
  );
});
