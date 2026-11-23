import * as Ballast from "@ballast/core";
import { Effect } from "effect";
import { a } from "./src/a.ts";
import { b } from "./src/b.ts";

export default Effect.gen(function* () {
  const connection = yield* Ballast.Connection<"fake">({
    integration: "fake",
    slot: "main",
    location: "local",
  });
  yield* a(connection);
  yield* b(connection);
});
