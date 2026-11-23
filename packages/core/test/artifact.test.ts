import { describe, expect, it } from "@effect/vitest";
import { MessageChannel } from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Ballast from "../src/index.ts";

const DashboardApi = RpcGroup.make(
  Rpc.make("Get", { success: Schema.Number }),
  Ballast.Api.action(Rpc.make("Increment", { success: Schema.Number })),
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
  it.effect("serves a query, an action, a stream and stores in-process", () =>
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
