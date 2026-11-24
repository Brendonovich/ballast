import * as Ballast from "@ballast/core";
import { Effect } from "effect";

export default Effect.gen(function* () {
  yield* Ballast.Artifact("ok", { entry: "./artifacts/ok/main.ts" });
});
