import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventHistory,
  EventHistoryLive,
  historyRegistration,
} from "../src/service/event-history.ts";
import {
  EventLogLive,
  EventRouter,
  EventRouterLive,
} from "../src/service/telemetry.ts";
import type { RuntimeSession } from "../src/runtime-session.ts";

const PlatformLive = Layer.mergeAll(
  NodeCrypto.layer,
  NodeFileSystem.layer,
  NodePath.layer,
);

const RouterLive = EventRouterLive.pipe(
  Layer.provideMerge(EventHistoryLive),
  Layer.provideMerge(EventLogLive),
  Layer.provide(PlatformLive),
);

const withTempProject = <A, E>(
  run: (root: string) => Effect.Effect<A, E, import("effect/Scope").Scope>,
): Effect.Effect<A, E, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-history-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
    );
    return yield* run(root);
  });

const project = (root: string) => ({
  id: "project-1",
  name: "History",
  root,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const topic = {
  name: "ticks",
  integration: "fake",
  slot: "main",
  topic: "tick",
  schemaFingerprint: "schema-v1",
};

describe("subscription event history", () => {
  it.effect("persists before delivery and survives a fresh host", () =>
    withTempProject((root) =>
      Effect.gen(function* () {
        const history = yield* EventHistory;
        yield* history.register(
          historyRegistration(project(root), "ballast.ts", [topic]),
        );

        const delivered: Array<unknown> = [];
        let fileDuringDelivery = "";
        const session: RuntimeSession = {
          generation: 1,
          subscriptions: new Set(["fake/main/tick"]),
          ready: Effect.void,
          exitReason: Effect.succeed(undefined),
          deliver: () => {
            fileDuringDelivery = readFileSync(
              join(root, ".ballast", "history", "ticks.jsonl"),
              "utf8",
            );
            delivered.push("tick");
          },
          deliverTimer: () => undefined,
          updateParams: () => undefined,
          close: Effect.void,
        };

        const router = yield* EventRouter;
        yield* router.expectSubscriptions({
          projectId: "project-1",
          scriptId: "ballast.ts",
          subscriptions: ["fake/main/tick"],
        });
        yield* router.publishInbound({
          integration: "fake",
          slot: "main",
          topic: "tick",
          payload: { n: 1 },
        });
        expect(delivered).toEqual([]);
        const record = yield* history.query("project-1", "ticks", { limit: 10 });
        expect(record.map((entry) => entry.event)).toEqual([{ n: 1 }]);
        expect(record[0]?.fingerprint).toBe("schema-v1");

        yield* router.register({
          projectId: "project-1",
          scriptId: "ballast.ts",
          session,
        });
        expect(delivered).toEqual(["tick"]);
        expect(fileDuringDelivery).toContain('"n":1');
      }).pipe(Effect.provide(RouterLive)),
    ).pipe(Effect.provide(PlatformLive), Effect.scoped),
  );

  it.live("enforces maxEntries and retention", () =>
    withTempProject((root) =>
      Effect.gen(function* () {
        const history = yield* EventHistory;
        const old = {
          cursor: "1",
          receivedAt: Date.now() - 60_000,
          fingerprint: "schema-v1",
          event: { n: 0 },
        };
        yield* Effect.promise(async () => {
          await mkdir(join(root, ".ballast", "history"), { recursive: true });
          await writeFile(
            join(root, ".ballast", "history", "short.jsonl"),
            JSON.stringify(old) + "\n",
            "utf8",
          );
        });
        yield* history.register(
          historyRegistration(project(root), "ballast.ts", [
            { ...topic, name: "capped", history: { maxEntries: 2, retentionMs: 60_000 } },
            { ...topic, name: "short", history: { maxEntries: 10, retentionMs: 1_000 } },
          ]),
        );
        yield* history.record("project-1", "capped", { n: 1 });
        yield* history.record("project-1", "capped", { n: 2 });
        yield* history.record("project-1", "capped", { n: 3 });
        const capped = yield* history.query("project-1", "capped", { limit: 10 });
        expect(capped.map((entry) => entry.event)).toEqual([{ n: 3 }, { n: 2 }]);

        yield* history.record("project-1", "short", { n: 2 });
        const short = yield* history.query("project-1", "short", { limit: 10 });
        expect(short.map((entry) => entry.event)).toEqual([{ n: 2 }]);

        const lines = (yield* Effect.promise(() =>
          readFile(join(root, ".ballast", "history", "capped.jsonl"), "utf8"),
        ));
        expect(lines.trim().split("\n")).toHaveLength(2);
      }).pipe(Effect.provide(EventHistoryLive), Effect.provide(PlatformLive)),
    ).pipe(Effect.provide(PlatformLive), Effect.scoped),
  );

  it.effect("stores nothing when history is off", () =>
    withTempProject((root) =>
      Effect.gen(function* () {
        const history = yield* EventHistory;
        yield* history.register(
          historyRegistration(project(root), "ballast.ts", [
            { ...topic, name: "quiet", history: false },
          ]),
        );
        const record = yield* history.record("project-1", "quiet", { n: 1 });
        expect(record).toBeUndefined();
        expect(yield* history.query("project-1", "quiet", { limit: 10 })).toEqual([]);
      }).pipe(Effect.provide(EventHistoryLive), Effect.provide(PlatformLive)),
    ).pipe(Effect.provide(PlatformLive), Effect.scoped),
  );

  it.effect("pages newest first with before cursors", () =>
    withTempProject((root) =>
      Effect.gen(function* () {
        const history = yield* EventHistory;
        yield* history.register(
          historyRegistration(project(root), "ballast.ts", [topic]),
        );
        yield* history.record("project-1", "ticks", { n: 1 });
        yield* history.record("project-1", "ticks", { n: 2 });
        yield* history.record("project-1", "ticks", { n: 3 });
        const first = yield* history.query("project-1", "ticks", { limit: 2 });
        expect(first.map((entry) => entry.event)).toEqual([{ n: 3 }, { n: 2 }]);
        const before = first[1]?.cursor;
        if (before === undefined) throw new Error("missing cursor");
        const second = yield* history.query("project-1", "ticks", {
          limit: 2,
          before,
        });
        expect(second.map((entry) => entry.event)).toEqual([{ n: 1 }]);
      }).pipe(Effect.provide(EventHistoryLive), Effect.provide(PlatformLive)),
    ).pipe(Effect.provide(PlatformLive), Effect.scoped),
  );

  it.live("watch delivers new records", () =>
    withTempProject((root) =>
      Effect.gen(function* () {
        const history = yield* EventHistory;
        yield* history.register(
          historyRegistration(project(root), "ballast.ts", [topic]),
        );
        const fiber = yield* Effect.forkScoped(
          history.live("project-1").pipe(Stream.take(1), Stream.runCollect),
        );
        yield* Effect.sleep("10 millis");
        yield* history.record("project-1", "ticks", { n: 7 });
        const items = yield* Fiber.join(fiber);
        const values = Array.from(items);
        expect(values).toHaveLength(1);
        expect(values[0]?.record.event).toEqual({ n: 7 });
      }).pipe(Effect.provide(EventHistoryLive), Effect.provide(PlatformLive)),
    ).pipe(Effect.provide(PlatformLive), Effect.scoped),
  );
});
