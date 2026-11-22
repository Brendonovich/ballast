import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes("main") });
  const obs = yield* OBS.Connection("main");

  yield* OBS.CurrentProgramSceneChanged.subscribe(obs, (event) =>
    Effect.log(`scene now ${event.sceneName}`),
  );

  yield* Ballast.run(
    Effect.gen(function* () {
      const target = yield* scene;
      yield* Effect.log(`set scene ${target}`);
      yield* obs.SetCurrentProgramScene({ sceneName: target });
    }),
  );
});
