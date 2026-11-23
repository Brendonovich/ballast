import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { TestClock } from "effect/testing";
import * as BW from "../src/index.ts";

const Payload = Schema.Struct({ id: Schema.String });
const Done = DurableDeferred.make("done", {
  success: Schema.Struct({ by: Schema.String }),
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

const makeStore = () => BW.makeMemoryWorkflowStore();

const startEngine = (
  store: BW.WorkflowStoreService,
  fingerprint: string,
  policy: BW.WorkflowVersionPolicy = "abort",
  clock?: import("effect/Clock").Clock,
) =>
  Effect.gen(function* () {
    const actualClock =
      clock ?? (yield* TestClock.testClockWith((testClock) => Effect.succeed(testClock)));
    return yield* BW.makeWorkflowEngine({
      store,
      clock: actualClock,
      fingerprint,
      versionPolicy: policy,
    });
  });

const provideEngine = <A, E>(
  effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>,
  engine: WorkflowEngine.WorkflowEngine["Service"],
) => Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine);

describe("@ballast/workflow", () => {
  it.effect("runs activity -> durable sleep -> activity and only runs each activity once", () =>
    Effect.gen(function* () {
      const store = yield* makeStore();
      const engine = yield* startEngine(store, "v1");
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);

      const first = Activity.make({
        name: "first",
        success: Schema.Number,
        execute: Ref.updateAndGet(runs, (list) => [...list, "first"]).pipe(Effect.as(1)),
      });
      const second = Activity.make({
        name: "second",
        success: Schema.Number,
        execute: Ref.updateAndGet(runs, (list) => [...list, "second"]).pipe(Effect.as(2)),
      });

      const flow = yield* provideEngine(
        BW.make(
          "three-step",
          {
            payload: Payload,
            success: Schema.Number,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              const a = yield* first;
              yield* BW.sleep("pause", "5 seconds");
              const b = yield* second;
              return a + b;
            }),
        ),
        engine,
      );

      const fiber = yield* provideEngine(
        flow.execute({ id: "run-1" }),
        engine,
      ).pipe(Effect.forkChild);
      yield* waitFor(
        store.load,
        (value) => (value.clocks?.timers.length ?? 0) > 0,
      );
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);

      expect(result).toBe(3);
      expect(yield* Ref.get(runs)).toEqual(["first", "second"]);

      const again = yield* provideEngine(flow.execute({ id: "run-1" }), engine);
      expect(again).toBe(3);
      expect(yield* Ref.get(runs)).toEqual(["first", "second"]);
    }),
  );

  it.effect("resumes mid-sleep after a simulated host restart with the JSON store", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-workflow-")));
      const path = join(directory, "workflow.json");
      const store = BW.makeJsonWorkflowStore(path);
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);

      const first = Activity.make({
        name: "first",
        success: Schema.Number,
        execute: Ref.updateAndGet(runs, (list) => [...list, "first"]).pipe(Effect.as(1)),
      });
      const second = Activity.make({
        name: "second",
        success: Schema.Number,
        execute: Ref.updateAndGet(runs, (list) => [...list, "second"]).pipe(Effect.as(2)),
      });

      const firstEngine = yield* startEngine(store, "v1");
      const flow = yield* provideEngine(
        BW.make(
          "restart",
          {
            payload: Payload,
            success: Schema.Number,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              const a = yield* first;
              yield* BW.sleep("pause", "30 seconds");
              const b = yield* second;
              return a + b;
            }),
        ),
        firstEngine,
      );

      yield* provideEngine(
        flow.execute({ id: "restart-1" }, { discard: true }),
        firstEngine,
      );
      const snapshot = yield* waitFor(
        store.load,
        (value) =>
          value.executions.length > 0 &&
          value.executions[0]?.status === "suspended",
      );

      expect(snapshot.executions[0]?.status).toBe("suspended");
      expect(yield* Ref.get(runs)).toEqual(["first"]);

      const secondClock = yield* TestClock.make();
      const secondEngine = yield* startEngine(store, "v1", "abort", secondClock);
      yield* provideEngine(
        BW.make(
          "restart",
          {
            payload: Payload,
            success: Schema.Number,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              const a = yield* first;
              yield* BW.sleep("pause", "30 seconds");
              const b = yield* second;
              return a + b;
            }),
        ),
        secondEngine,
      );
      yield* waitFor(
        store.load,
        (value) => (value.clocks?.timers.length ?? 0) > 0,
      );
      yield* secondClock.adjust("30 seconds");
      yield* waitFor(
        store.load,
        (value) =>
          value.executions.length > 0 &&
          value.executions[0]?.status === "complete",
      );

      expect(yield* Ref.get(runs)).toEqual(["first", "second"]);
    }),
  );

  it.effect("resolves a deferred from a simulated topic event and resumes the workflow", () =>
    Effect.gen(function* () {
      const store = yield* makeStore();
      const engine = yield* startEngine(store, "v1");
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);

      const record = Activity.make({
        name: "record",
        success: Schema.Void,
        execute: Ref.updateAndGet(runs, (list) => [...list, "before"]).pipe(Effect.asVoid),
      });
      const after = Activity.make({
        name: "after",
        success: Schema.Void,
        execute: Ref.updateAndGet(runs, (list) => [...list, "after"]).pipe(Effect.asVoid),
      });

      const flow = yield* provideEngine(
        BW.make(
          "event-wait",
          {
            payload: Payload,
            success: Schema.String,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              yield* record;
              const done = yield* DurableDeferred.await(Done);
              yield* after;
              return done.by;
            }),
        ),
        engine,
      );

      const fiber = yield* provideEngine(
        flow.execute({ id: "wait-1" }),
        engine,
      ).pipe(Effect.forkChild);
      yield* waitFor(store.load, (snapshot) => snapshot.executions[0]?.status === "suspended");
      const executionId = yield* flow.executionId({ id: "wait-1" });
      yield* provideEngine(
        flow.resolve(executionId, Done, Exit.succeed({ by: "chat" })),
        engine,
      );

      const result = yield* Fiber.join(fiber);
      expect(result).toBe("chat");
      expect(yield* Ref.get(runs)).toEqual(["before", "after"]);
    }),
  );

  it.effect("aborts a replay when the fingerprint changed under the configured policy", () =>
    Effect.gen(function* () {
      const store = yield* makeStore();
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);

      const first = Activity.make({
        name: "first",
        success: Schema.Number,
        execute: Ref.updateAndGet(runs, (list) => [...list, "first"]).pipe(Effect.as(1)),
      });

      const firstEngine = yield* startEngine(store, "v1");
      const flow = yield* provideEngine(
        BW.make(
          "versioned",
          {
            payload: Payload,
            success: Schema.Number,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              const a = yield* first;
              yield* BW.sleep("pause", "30 seconds");
              return a;
            }),
        ),
        firstEngine,
      );
      yield* provideEngine(
        flow.execute({ id: "version-1" }, { discard: true }),
        firstEngine,
      );
      yield* waitFor(store.load, (snapshot) => snapshot.executions[0]?.status === "suspended");

      const secondEngine = yield* startEngine(store, "v2", "abort");
      yield* provideEngine(
        BW.make(
          "versioned",
          {
            payload: Payload,
            success: Schema.Number,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              const a = yield* first;
              yield* BW.sleep("pause", "30 seconds");
              return a;
            }),
        ),
        secondEngine,
      );
      const exit = yield* provideEngine(
        flow.execute({ id: "version-1" }),
        secondEngine,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(runs)).toEqual(["first"]);
    }),
  );

  it.effect("re-runs an activity after a crash before its journal write", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<string>>([]);
      const activity = Activity.make({
        name: "after-crash",
        success: Schema.Void,
        execute: Ref.updateAndGet(runs, (list) => [...list, "ran"]).pipe(Effect.asVoid),
      });

      const store = yield* makeStore();
      const engine = yield* startEngine(store, "v1");
      const flow = yield* provideEngine(
        BW.make(
          "crash",
          {
            payload: Payload,
            idempotencyKey: (payload) => payload.id,
          },
          () => Effect.gen(function* () {
            yield* activity;
          }),
        ),
        engine,
      );

      const executionId = yield* flow.executionId({ id: "crash-1" });
      const seeded = yield* BW.makeMemoryWorkflowStore({
        version: 1,
        executions: [
          {
            executionId,
            workflowName: "crash",
            payload: { id: "crash-1" },
            fingerprint: "v1",
            status: "running",
            activities: [],
            deferreds: {},
          },
        ],
      });
      const crashEngine = yield* startEngine(seeded, "v1");
      yield* provideEngine(
        BW.make(
          "crash",
          {
            payload: Payload,
            idempotencyKey: (payload) => payload.id,
          },
          () => Effect.gen(function* () {
            yield* activity;
          }),
        ),
        crashEngine,
      );
      yield* provideEngine(flow.execute({ id: "crash-1" }), crashEngine);

      expect(yield* Ref.get(runs)).toEqual(["ran"]);
    }),
  );

  it.effect("fails loudly when one run uses the same activity name twice", () =>
    Effect.gen(function* () {
      const store = yield* makeStore();
      const engine = yield* startEngine(store, "v1");
      const duplicate = Activity.make({
        name: "same",
        success: Schema.Void,
        execute: Effect.void,
      });

      const flow = yield* provideEngine(
        BW.make(
          "duplicate",
          {
            payload: Payload,
            idempotencyKey: (payload) => payload.id,
          },
          () =>
            Effect.gen(function* () {
              yield* duplicate;
              yield* duplicate;
            }),
        ),
        engine,
      );
      const exit = yield* provideEngine(
        flow.execute({ id: "duplicate-1" }),
        engine,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
