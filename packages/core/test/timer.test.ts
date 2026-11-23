import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import * as Ballast from "../src/index.ts";

const makeRecorder = (ref: Ref.Ref<Ballast.Manifest>): Ballast.ManifestRecorderService => ({
  project: (project) => Ref.update(ref, (manifest) => ({ ...manifest, project })),
  param: (param) =>
    Ref.update(ref, (manifest) => ({ ...manifest, params: [...manifest.params, param] })),
  connection: (connection) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      connections: [...manifest.connections, connection],
    })),
  topic: (topic) =>
    Ref.update(ref, (manifest) => ({ ...manifest, topics: [...manifest.topics, topic] })),
  request: (request) =>
    Ref.update(ref, (manifest) => ({ ...manifest, requests: [...manifest.requests, request] })),
  unresolved: (unresolved) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      unresolved: [...manifest.unresolved, unresolved],
    })),
  timer: (timer) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      timers: [...manifest.timers, timer],
    })),
  workflow: (workflow) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      workflows: [...manifest.workflows, workflow],
    })),
  run: (run) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      runs: [...manifest.runs, run],
    })),
});

const cooldownPayload = Schema.Struct({ user: Schema.String });

const schedule = (
  key: string,
  delayMs: number,
  payload: { readonly user: string },
  options: {
    readonly onStale?: "drop" | "deliver";
    readonly maxAgeMs?: number;
  } = {},
): Ballast.TimerScheduleInput => ({
  scriptId: "script",
  timer: "cooldown",
  key,
  delayMs,
  payload,
  payloadFingerprint: "fingerprint",
  onStale: options.onStale ?? "deliver",
  maxAgeMs: options.maxAgeMs ?? Ballast.DEFAULT_TIMER_MAX_AGE_MS,
});

const waitFor = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    while (true) {
      const value = yield* effect;
      if (predicate(value)) return value;
      yield* Effect.yieldNow;
    }
  });

const makeScheduler = (options?: {
  readonly initial?: Ballast.TimerStoreSnapshot;
}) =>
  Effect.gen(function* () {
    const fires = yield* Queue.unbounded<Ballast.TimerFireRecord>();
    const scheduler = yield* TestClock.testClockWith((clock) =>
      Ballast.makeTimerScheduler({
        clock,
        ...(options?.initial === undefined ? {} : { initial: options.initial }),
        onFire: (fire) => Queue.offer(fires, fire).pipe(Effect.asVoid),
      }),
    );
    return { fires, scheduler };
  });

describe("@ballast/core timers", () => {
  it.effect("records a timer declaration during plan", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("timers"));
      const script = Effect.gen(function* () {
        yield* Ballast.Timer.subscribe(
          "cooldown",
          cooldownPayload,
          () => Effect.void,
          {
            title: "Cooldown",
            onStale: "deliver",
            maxAgeMs: 60_000,
          },
        );
      });

      yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), makeRecorder(ref));

      const manifest = yield* Ref.get(ref);
      expect(manifest.timers).toHaveLength(1);
      expect(manifest.timers[0]?.name).toBe("cooldown");
      expect(manifest.timers[0]?.title).toBe("Cooldown");
      expect(manifest.timers[0]?.onStale).toBe("deliver");
      expect(manifest.timers[0]?.maxAgeMs).toBe(60_000);
      expect(manifest.timers[0]?.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.timers[0]?.payloadSchema).toBeDefined();
    }),
  );

  it.effect("dies when a timer is scheduled during plan", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("timer-after-plan"));
      const script = Effect.gen(function* () {
        const cooldown = yield* Ballast.Timer.subscribe(
          "cooldown",
          cooldownPayload,
          () => Effect.void,
        );
        yield* cooldown.after("user:1", "1 minute", { user: "1" });
      });

      const exit = yield* Ballast.providePlan(
        // @ts-expect-error scheduling a timer in init requires Runtime
        Ballast.evaluateScript(script, "plan"),
        makeRecorder(ref),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("TimerCalledDuringPlanError");
      }
    }),
  );

  it.effect("fires a scheduled timer after the test clock reaches it", () =>
    Effect.gen(function* () {
      const { fires, scheduler } = yield* makeScheduler();
      yield* scheduler.schedule(schedule("user:1", 10 * 60_000, { user: "1" }));

      yield* TestClock.adjust("10 minutes");

      const fire = yield* Queue.take(fires);
      expect(fire.timer).toBe("cooldown");
      expect(fire.key).toBe("user:1");
      expect(fire.payload).toEqual({ user: "1" });
      expect(fire.lateByMs).toBe(0);
    }),
  );

  it.effect("replaces a timer by key", () =>
    Effect.gen(function* () {
      const { fires, scheduler } = yield* makeScheduler();
      yield* scheduler.schedule(schedule("user:1", 10 * 60_000, { user: "old" }));
      yield* scheduler.schedule(schedule("user:1", 20 * 60_000, { user: "new" }));

      yield* TestClock.adjust("10 minutes");
      expect(Option.isNone(yield* Queue.poll(fires))).toBe(true);

      yield* TestClock.adjust("10 minutes");
      const fire = yield* Queue.take(fires);
      expect(fire.payload).toEqual({ user: "new" });
    }),
  );

  it.effect("cancels a pending timer", () =>
    Effect.gen(function* () {
      const { fires, scheduler } = yield* makeScheduler();
      yield* scheduler.schedule(schedule("user:1", 10 * 60_000, { user: "1" }));
      yield* scheduler.cancel("script", "cooldown", "user:1");

      yield* TestClock.adjust("1 hour");

      expect(Option.isNone(yield* Queue.poll(fires))).toBe(true);
      expect(yield* scheduler.pending).toEqual([]);
    }),
  );

  it.effect("restores persisted timers and fires them after a host restart", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make();
      const first = yield* makeScheduler().pipe(Scope.provide(firstScope));
      yield* first.scheduler.schedule(
        schedule("user:1", 10 * 60_000, { user: "1" }),
      );
      const snapshot = yield* first.scheduler.snapshot;
      const persisted = Ballast.decodeTimerStoreSnapshot(
        JSON.parse(JSON.stringify(snapshot)),
      );
      yield* Scope.close(firstScope, Exit.void);

      const restored = yield* makeScheduler({ initial: persisted });
      yield* TestClock.adjust("10 minutes");

      const fire = yield* Queue.take(restored.fires);
      expect(fire.key).toBe("user:1");
      expect(fire.payload).toEqual({ user: "1" });
    }),
  );

  it.effect("drops a missed fire when onStale is drop", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make();
      const first = yield* makeScheduler().pipe(Scope.provide(firstScope));
      yield* first.scheduler.schedule(
        schedule("user:1", 60_000, { user: "1" }, { onStale: "drop", maxAgeMs: 30_000 }),
      );
      const snapshot = yield* first.scheduler.snapshot;
      const persisted = Ballast.decodeTimerStoreSnapshot(
        JSON.parse(JSON.stringify(snapshot)),
      );
      yield* Scope.close(firstScope, Exit.void);
      yield* TestClock.setTime(10 * 60_000);

      const restored = yield* makeScheduler({ initial: persisted });

      const after = yield* waitFor(
        restored.scheduler.snapshot,
        (value) => value.timers[0]?.state === "dropped",
      );
      expect(after.timers[0]?.state).toBe("dropped");
      expect(yield* restored.scheduler.pending).toEqual([]);
      expect(Option.isNone(yield* Queue.poll(restored.fires))).toBe(true);
    }),
  );

  it.effect("delivers a missed fire with lateByMs when onStale is deliver", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make();
      const first = yield* makeScheduler().pipe(Scope.provide(firstScope));
      yield* first.scheduler.schedule(
        schedule("user:1", 60_000, { user: "1" }, { onStale: "deliver", maxAgeMs: 30_000 }),
      );
      const snapshot = yield* first.scheduler.snapshot;
      const persisted = Ballast.decodeTimerStoreSnapshot(
        JSON.parse(JSON.stringify(snapshot)),
      );
      yield* Scope.close(firstScope, Exit.void);
      yield* TestClock.setTime(10 * 60_000);

      const restored = yield* makeScheduler({ initial: persisted });

      const fire = yield* Queue.take(restored.fires);
      expect(fire.lateByMs).toBe(9 * 60_000);
    }),
  );

  it.effect("schedules through the runtime timer handle", () =>
    Effect.gen(function* () {
      const scheduled: Array<{ readonly key: string; readonly payload: unknown }> = [];
      const runtime: Ballast.TimerRuntimeService = {
        subscribe: () => Effect.void,
        schedule: (_timer, input) =>
          Effect.sync(() => {
            scheduled.push({ key: input.key, payload: input.payload });
          }),
        cancel: () => Effect.void,
      };

      const script = Effect.gen(function* () {
        const cooldown = yield* Ballast.Timer.subscribe(
          "cooldown",
          cooldownPayload,
          () => Effect.void,
        );
        yield* cooldown.after("user:1", "1 minute", { user: "1" });
      });

      yield* Ballast.evaluateScript(
        script.pipe(Effect.provideService(Ballast.Runtime, {})),
        "runtime",
      ).pipe(Effect.provideService(Ballast.Timer.TimerRuntime, runtime));

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.key).toBe("user:1");
      expect(scheduled[0]?.payload).toEqual({ user: "1" });
    }),
  );
});
