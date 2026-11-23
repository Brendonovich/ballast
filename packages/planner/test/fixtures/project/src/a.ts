import * as Ballast from "@ballast/core";
import * as Workflow from "@ballast/workflow";
import { Effect, Schema } from "effect";

const tick = Ballast.Topic<{ n: number }, "fake">({
  integration: "fake",
  topic: "fake/tick",
  scopes: ["fake:read"],
});

export const subscribeTicks = (
  connection: Ballast.ConnectionRef<"fake">,
) =>
  Effect.gen(function* () {
    const greeting = yield* Ballast.Param.string("greeting", {
      title: "Greeting",
      description: "Shown in the fixture",
      default: "hi",
    });

    yield* Ballast.Timer.subscribe(
      "heartbeat",
      Schema.Void,
      () => Effect.log("heartbeat"),
      { title: "Heartbeat" },
    );

    yield* Ballast.run(
      "ticker",
      Effect.gen(function* () {
        yield* Effect.log("ticker " + (yield* greeting));
      }),
    );

    yield* Workflow.make(
      "fixture-workflow",
      {
        payload: Schema.Struct({ id: Schema.String }),
        success: Schema.Void,
        idempotencyKey: (payload) => payload.id,
      },
      () =>
        Effect.gen(function* () {
          yield* Workflow.sleep("hold", "1 second");
        }),
    );

    yield* tick.subscribe("named-tick", connection, (event) =>
      Effect.log(`tick ${event.n}`),
    );
  });
