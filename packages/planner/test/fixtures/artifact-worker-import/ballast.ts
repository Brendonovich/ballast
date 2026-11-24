import * as Ballast from "@ballast/core";
import { Effect } from "effect";

export default Effect.gen(function* () {
  yield* Ballast.Artifact("bad", { entry: "./artifacts/bad/main.ts" });
});
