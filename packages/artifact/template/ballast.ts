import * as Ballast from "@ballast/core";
import { Effect, Schema, Stream } from "effect";
import { DashboardApi } from "./src/api.ts";

export const title = "Stream dashboard";

export default Effect.gen(function* () {
  const sceneSwitches = yield* Ballast.Store.counter("sceneSwitches", { initial: 0 });

  const snapshot = () =>
    Effect.gen(function* () {
      return {
        sceneSwitches: yield* sceneSwitches.get,
        at: Date.now(),
      };
    });

  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    description: "A counter and a live snapshot stream.",
    entry: "./artifacts/dashboard/main.tsx",
  });

  yield* Ballast.Api.serve(DashboardApi, {
    Snapshot: snapshot,
    ResetCounters: () =>
      Effect.gen(function* () {
        yield* sceneSwitches.reset;
        return yield* sceneSwitches.get;
      }),
    Events: () => Stream.tick("1 second").pipe(Stream.mapEffect(snapshot)),
  });

  let heartbeat: Ballast.Timer.Timer<void> | undefined;
  const registered = yield* Ballast.Timer.subscribe(
    "dashboard-heartbeat",
    Schema.Void,
    () =>
      Effect.gen(function* () {
        yield* sceneSwitches.increment(1);
        if (heartbeat !== undefined) {
          yield* heartbeat.after("main", "1 second");
        }
      }),
    { title: "Dashboard heartbeat" },
  );
  heartbeat = registered;

  yield* Ballast.run("start-heartbeat", registered.after("main", "1 second"));
});
