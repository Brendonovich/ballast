import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Ballast from "../src/index.ts";

const Ping = RpcGroup.make(Rpc.make("Ping", { success: Schema.Number }));

const handlers: RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof Ping>> = {
  Ping: () =>
    Effect.gen(function* () {
      yield* Ballast.Runtime;
      return 1;
    }),
};

const storeReadInInit = Effect.gen(function* () {
  const counter = yield* Ballast.Store.counter("bad-init", { initial: 0 });
  yield* counter.get;
});

// @ts-expect-error a store read requires Ballast.Runtime, which Project excludes
const project: Ballast.Project = Effect.asVoid(storeReadInInit);

const HistoryTopic = Ballast.Topic<{ n: number }, "fake">({
  integration: "fake",
  topic: "fake/history",
  schema: Schema.Struct({ n: Schema.Number }),
});

const historyQueryInInit = Effect.gen(function* () {
  const subscription = yield* HistoryTopic.subscribe(
    "history",
    { integration: "fake", slot: "main", location: "local" },
    () => Effect.void,
  );
  yield* subscription.query({ limit: 1 });
});

// @ts-expect-error history.query requires Ballast.Runtime, which Project excludes
const historyProject: Ballast.Project = Effect.asVoid(historyQueryInInit);

describe("artifact type surface", () => {
  it("accepts Runtime-backed API handlers", () => {
    expect(handlers.Ping).toBeTypeOf("function");
    expect(project).toBeDefined();
    expect(historyProject).toBeDefined();
  });

  it("records each procedure and whether it streams", () => {
    const manifest = Ballast.Api.toApiManifest(Ping, undefined);
    expect(manifest.procedures[0]?.name).toBe("Ping");
    expect(manifest.procedures[0]?.stream).toBe(false);
    expect(manifest.procedures[0]).not.toHaveProperty("kind");
  });
});
