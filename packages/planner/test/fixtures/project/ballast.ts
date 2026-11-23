import * as Ballast from "@ballast/core";
import { Effect } from "effect";
import { subscribeTicks } from "./src/a.ts";

export default Effect.gen(function* () {
  const connection = yield* Ballast.Connection<"fake">({
    integration: "fake",
    slot: "main",
    location: "local",
  });
  yield* subscribeTicks(connection);
});
