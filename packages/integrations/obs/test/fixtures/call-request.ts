import * as Ballast from "@ballast/core";
import { Effect } from "effect";
import * as OBS from "../../src/index.ts";

/** Plan must kill this: init may declare a request, never call it. */
export default Ballast.Script(
  "obs-call-request",
  Effect.gen(function* () {
    const obs = yield* OBS.Connection("main");
    yield* obs.SetCurrentProgramScene({ sceneName: "Scene 1" });
  }),
);
