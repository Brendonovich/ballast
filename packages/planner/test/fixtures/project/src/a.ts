import * as Ballast from "@ballast/core";
import { Effect } from "effect";

const tick = Ballast.Topic<{ n: number }, "fake">({
  integration: "fake",
  topic: "fake/tick",
  scopes: ["fake:read"],
});

export const subscribeTicks = (
  connection: Ballast.ConnectionRef<"fake">,
) =>
  Effect.gen(function* () {
    yield* tick.subscribeNamed("named-tick", connection, (event) =>
      Effect.log(`tick ${event.n}`),
    );
  });
