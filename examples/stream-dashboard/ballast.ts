import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect, Stream } from "effect";
import { DashboardApi, DashboardEvent } from "./src/api.ts";

export const title = "Stream dashboard";

const toDashboardEvent = (
  entry: Ballast.HistoryEntry<Fake.ChatPayload>,
): DashboardEvent =>
  entry._tag === "Event"
    ? {
        cursor: entry.cursor,
        at: entry.receivedAt,
        kind: "message",
        text: entry.event.text,
      }
    : {
        cursor: entry.cursor,
        at: entry.receivedAt,
        kind: "legacy",
        text: "[older schema]",
      };

export default Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  const sceneSwitches = yield* Ballast.Store.counter("sceneSwitches", { initial: 0 });
  const messages = yield* Ballast.Store.counter("messages", { initial: 0 });

  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    description: "Live counters and chat history for the project.",
    entry: "./artifacts/dashboard/main.tsx",
  });

  const chat = yield* Fake.Chat.subscribe(
    "chat-log",
    fake,
    () =>
      Effect.gen(function* () {
        yield* messages.increment(1);
      }),
    { history: { maxEntries: 500, retention: "7 days" } },
  );

  const snapshot = () =>
    Effect.gen(function* () {
      const history = yield* chat.query({ limit: 50 });
      return {
        sceneSwitches: yield* sceneSwitches.get,
        messages: yield* messages.get,
        events: history.map(toDashboardEvent),
      };
    });

  yield* Ballast.Api.serve(DashboardApi, {
    Snapshot: snapshot,
    ResetCounters: () =>
      Effect.gen(function* () {
        yield* sceneSwitches.reset;
        yield* messages.reset;
        return 0;
      }),
    Chat: () => chat.watch().pipe(Stream.map((entry) => toDashboardEvent(entry))),
  });

  yield* Fake.Tick.subscribe("scene-tick", fake, () =>
    Effect.gen(function* () {
      yield* sceneSwitches.increment(1);
    }),
  );

  yield* Ballast.run("dashboard-ready", Effect.log("stream dashboard ready"));
});
