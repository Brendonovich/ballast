import { describe, expect, it } from "@effect/vitest";
import { MessageChannel } from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Ballast from "../src/index.ts";

const DashboardApi = RpcGroup.make(
  Rpc.make("Get", { success: Schema.Number }),
  Rpc.make("Increment", { success: Schema.Number }),
  Rpc.make("Ticks", { stream: true, success: Schema.Number }),
);

const script = Effect.gen(function* () {
  const count = yield* Ballast.Store.counter("count", { initial: 2 });

  yield* Ballast.Api.serve(DashboardApi, {
    Get: () => count.get,
    Increment: () => count.increment(1),
    Ticks: () => Stream.make(1, 2, 3),
  });
});

describe("artifact worker contract", () => {
  it.effect("serves calls, a stream and stores in-process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Ballast.evaluateScript(script, "runtime").pipe(
          Effect.provide(Ballast.StoreHostMemory),
          Effect.provideService(
            Ballast.Settings,
            Ballast.Settings.of({ get: () => Effect.succeed(undefined) }),
          ),
          Effect.provideService(
            Ballast.EventBus,
            Ballast.EventBus.of({ subscribe: () => Effect.void }),
          ),
          Effect.provideService(
            Ballast.RequestClients,
            Ballast.RequestClients.of({
              client: () => Effect.die(new Error("requests are not used in this test")),
            }),
          ),
        );
        const start = yield* runtime.api;
        expect(start).toBeDefined();
        if (start === undefined) return;

        const channel = new MessageChannel();
        yield* Effect.forkScoped(start(channel.port2));
        const client = yield* Ballast.makeArtifactRpcClient(
          channel.port1,
          DashboardApi,
        );

        const before = yield* client.Get();
        expect(before).toBe(2);

        const incremented = yield* client.Increment();
        expect(incremented).toBe(3);

        const after = yield* client.Get();
        expect(after).toBe(3);

        const ticks = yield* client.Ticks().pipe(Stream.runCollect);
        expect(Array.from(ticks)).toEqual([1, 2, 3]);
      }),
    ),
  );
});

const makeArtifactRecorder = (
  ref: Ref.Ref<Ballast.Manifest>,
): Ballast.ManifestRecorderService => ({
  project: () => Effect.void,
  param: () => Effect.void,
  connection: () => Effect.void,
  topic: () => Effect.void,
  request: () => Effect.void,
  timer: () => Effect.void,
  workflow: () => Effect.void,
  run: () => Effect.void,
  api: () => Effect.void,
  store: () => Effect.void,
  database: () => Effect.void,
  artifact: (artifact) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      artifacts: [...manifest.artifacts, artifact],
    })),
  unresolved: (entry) =>
    Ref.update(ref, (manifest) => ({
      ...manifest,
      unresolved: [...manifest.unresolved, entry],
    })),
});

const withArtifactHost = <A, E, R>(
  host: Ballast.ArtifactHost | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.sync(() => {
    const previous = globalThis.__BALLAST_ARTIFACT_HOST__;
    globalThis.__BALLAST_ARTIFACT_HOST__ = host;
    return previous;
  }).pipe(
    Effect.flatMap((previous) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.__BALLAST_ARTIFACT_HOST__ = previous;
          }),
        ),
      ),
    ),
  );

const planArtifact = (
  ref: Ref.Ref<Ballast.Manifest>,
  name: string,
): Effect.Effect<Ballast.ArtifactHandle> =>
  Ballast.providePlan(
    Ballast.Artifact(name, { entry: "./artifacts/" + name + ".ts", transparent: true }),
    makeArtifactRecorder(ref),
  );

describe("artifact handle URL", () => {
  it.effect("is the stable transparent URL when an artifact host is set", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("demo"));
      const host: Ballast.ArtifactHost = {
        origin: "http://127.0.0.1:47831",
        stableToken: "a1.demo.test",
      };

      const handle = yield* withArtifactHost(host, planArtifact(ref, "overlay"));

      expect(handle.url).toBe(
        "http://127.0.0.1:47831/a/a1.demo.test/overlay/index.html?background=transparent",
      );
      expect(handle.transparent).toBe(true);
      expect((yield* Ref.get(ref)).unresolved).toEqual([]);
    }),
  );

  it.effect("is a marked placeholder in plan without a host and records unresolved once", () =>
    Effect.gen(function* () {
      const ref = yield* Ref.make(Ballast.emptyManifest("demo"));

      const handle = yield* withArtifactHost(undefined, planArtifact(ref, "overlay"));
      const quiet = yield* withArtifactHost(undefined, planArtifact(ref, "quiet"));

      const first = handle.url;
      const second = handle.url;
      expect(first).toContain("unresolved");
      expect(first).toContain("overlay");
      expect(first.endsWith("?background=transparent")).toBe(true);
      expect(second).toBe(first);

      const manifest = yield* Ref.get(ref);
      expect(manifest.unresolved).toHaveLength(1);
      expect(manifest.unresolved[0]).toMatchObject({ path: "artifact:overlay" });
      expect(manifest.unresolved[0]?.reason).toContain("placeholder");
      // Reading nothing from quiet records nothing.
      expect(quiet.name).toBe("quiet");
    }),
  );

  it.effect("throws ArtifactUrlUnavailableError at runtime without a host", () =>
    Effect.gen(function* () {
      const handle = yield* withArtifactHost(
        undefined,
        Ballast.Artifact("overlay", { entry: "./artifacts/overlay.ts", transparent: true }).pipe(
          Effect.provideService(Ballast.ScriptPhase, "runtime"),
        ),
      );

      expect(() => handle.url).toThrow(Ballast.ArtifactUrlUnavailableError);
    }),
  );
});
