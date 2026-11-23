import * as Ballast from "@ballast/core";
import { Effect, Schema } from "effect";

const Tick = Ballast.Topic<{ n: number }, "fake">({
  integration: "fake",
  topic: "fake/tick",
  scopes: ["fake:read"],
});

const Chat = Ballast.Topic<{ text: string }, "fake">({
  integration: "fake",
  topic: "fake/chat",
  scopes: ["fake:chat"],
});

export const startAlerts = (connection: Ballast.ConnectionRef<"fake">) =>
  Effect.gen(function* () {
    const prefixParam = yield* Ballast.Param.string("prefix", {
      title: "Prefix",
      default: "[stream]",
    });

    const heartbeat = yield* Ballast.Timer.subscribe(
      "heartbeat",
      Schema.Struct({ at: Schema.Number }),
      () => Effect.log("heartbeat"),
      { title: "Heartbeat", onStale: "deliver", maxAgeMs: 60_000 },
    );

    yield* Tick.subscribe("tick-log", connection, (tick) =>
      Effect.gen(function* () {
        const prefix = yield* prefixParam;
        yield* Effect.log(prefix + " tick " + tick.n);
      }),
    );

    yield* Chat.subscribe("chat-log", connection, (chat) =>
      Effect.log("[chat] " + chat.text),
    );

    yield* Ballast.run(
      "welcome",
      Effect.gen(function* () {
        const prefix = yield* prefixParam;
        yield* heartbeat.after("global", "60 seconds", { at: Date.now() });
        yield* Effect.log(prefix + " ready");
      }),
    );
  });
