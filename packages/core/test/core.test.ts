import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
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

describe("@ballast/core plan phase", () => {
  it.effect("records declarations made by init", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("records"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
          const connection = yield* Ballast.Connection<"fake">({
            integration: "fake",
            slot: "main",
            location: "local",
          });
          const echo = yield* Ballast.Request<{ text: string }, { text: string }>({
            integration: "fake",
            slot: connection.slot,
            request: "fake/echo",
            scopes: ["fake:write"],
          });
          const tick = Ballast.Topic<{ n: number }, "fake">({
            integration: "fake",
            topic: "fake/tick",
            scopes: ["fake:read"],
          });
          yield* tick.subscribe("tick", connection, () => Effect.void);
          expect(tick.key(connection)).toBe("fake/main/fake/tick");
          expect(tick.topic).toBe("fake/tick");
          expect(tick.scopes).toEqual(["fake:read"]);
          expect(typeof echo).toBe("function");
        });

      yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder);

      const manifest = yield* Ref.get(ref);
      expect(manifest.project).toEqual({ id: "records", entry: "ballast.ts" });
      expect(manifest.params.map((param) => param.key)).toEqual(["prefix"]);
      expect(manifest.connections).toEqual([
        { integration: "fake", slot: "main", location: "local" },
      ]);
      expect(manifest.topics).toEqual([
        expect.objectContaining({
          integration: "fake",
          slot: "main",
          topic: "fake/tick",
          name: "tick",
          scopes: ["fake:read"],
          onStale: "drop",
          maxAgeMs: 60_000,
        }),
      ]);
      expect(manifest.topics[0]?.source).toBeDefined();
      expect(manifest.requests).toEqual([
        {
          integration: "fake",
          slot: "main",
          request: "fake/echo",
          scopes: ["fake:write"],
        },
      ]);
    }),
  );

  it.effect("records param help text and multi-select options", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("params"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          yield* Ballast.Param.strings("scenes", {
            title: "Scenes",
            description: "Pick one or more scenes",
            default: ["Scene 1"],
            options: { integration: "obs", slot: "main", source: "scenes" },
          });
        });

      yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder);

      const manifest = yield* Ref.get(ref);
      expect(manifest.params).toEqual([
        expect.objectContaining({
          key: "scenes",
          type: "strings",
          title: "Scenes",
          description: "Pick one or more scenes",
          default: ["Scene 1"],
          options: { integration: "obs", slot: "main", source: "scenes" },
        }),
      ]);
      expect(manifest.params[0]?.source).toBeDefined();
    }),
  );

  it.effect("records a connection request namespace", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("namespace"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          yield* Ballast.Connection({
            integration: "obs",
            slot: "main",
            location: "local",
            requests: ["*"],
          });
        });

      yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder);

      const manifest = yield* Ref.get(ref);
      expect(manifest.requests).toEqual([
        { integration: "obs", slot: "main", request: "obs/*", scopes: [] },
      ]);
    }),
  );

  it.effect("dies when a granted client is called in plan", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("granted"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          const host = yield* Ballast.RequestHost;
          const call = host.granted<{ text: string }, { text: string }>({
            integration: "obs",
            slot: "main",
            request: "SetCurrentProgramScene",
            scopes: [],
            key: "obs/main/SetCurrentProgramScene",
          });
          yield* call({ text: "no" });
        });

      // @ts-expect-error calling a request client in init requires Runtime
      const exit = yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("RequestCalledDuringPlanError");
      }
    }),
  );

  it.effect("dies when a request client is called", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("call-request"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          const echo = yield* Ballast.Request<{ text: string }, { text: string }>({
            integration: "fake",
            slot: "main",
            request: "fake/echo",
            scopes: ["fake:write"],
          });
          yield* echo({ text: "no" });
        });

      // @ts-expect-error calling a request client in init requires Runtime
      const exit = yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("RequestCalledDuringPlanError");
      }
    }),
  );

  it.effect("reads the current setting in runtime phase", () =>
    Effect.gen(function* () {
      const value = yield* Effect.gen(function* () {
        const prefix = yield* Ballast.Param.string("prefix", { default: ">" });
        return yield* prefix;
      }).pipe(
        Effect.provideService(Ballast.ScriptPhase, "runtime"),
        Effect.provideService(Ballast.Runtime, {}),
        Effect.provideService(Ballast.Settings, {
          get: (key) => Effect.succeed(key === "prefix" ? "hi" : undefined),
        }),
      );

      expect(value).toBe("hi");
    }),
  );

  it.effect("dies when a param is read", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("read-param"));
      const recorder = makeRecorder(ref);

      const script = Effect.gen(function* () {
          const prefix = yield* Ballast.Param.string("prefix", { default: ">" });
          yield* prefix;
        });

      // @ts-expect-error reading a param in init requires Runtime
      const exit = yield* Ballast.providePlan(Ballast.evaluateScript(script, "plan"), recorder).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("read during init");
      }
    }),
  );
});
