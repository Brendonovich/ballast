import * as Ballast from "@ballast/core";
import { Effect } from "effect";

// Reads the artifact handle's URL during init and records it as a param default,
// so a plan makes the resolved (or placeholder) value visible.
export default Effect.gen(function* () {
  const overlay = yield* Ballast.Artifact("overlay", {
    entry: "./artifacts/overlay.ts",
    transparent: true,
  });
  yield* Ballast.Param.string("overlayUrl", { default: overlay.url });
});
