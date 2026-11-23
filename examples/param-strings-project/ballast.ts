import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");

  const scenes = yield* Ballast.Param.strings("scenes", {
    title: "Scenes",
    description: "Pick one or more OBS scenes",
    options: OBS.scenes(obs),
    default: ["Scene 1"],
  });
  yield* OBS.CurrentProgramSceneChanged.subscribe("scene-changed", obs, () =>
    Effect.gen(function* () {
      yield* Effect.log("scenes: " + (yield* scenes).join(", "));
    }),
  );
});
