import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  yield* OBS.ConnectionState.subscribe("obs-state", obs, (state) =>
    Effect.log(state.state + " reconnected=" + String(state.reconnected)),
  );
});
