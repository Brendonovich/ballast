import * as Ballast from "@ballast/core";
import { Effect } from "effect";

const tick = Ballast.Topic<{ n: number }, "fake">({
  integration: "fake",
  topic: "fake/tick",
});

export const a = (connection: Ballast.ConnectionRef<"fake">) =>
  Effect.gen(function* () {
    yield* tick.subscribe("same-name", connection, () => Effect.void);
  });
