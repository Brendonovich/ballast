import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export const title = "Redeem to Scene";

export default Effect.gen(function* () {
  const rewardTitle = yield* Ballast.Param.string("rewardTitle");
  const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes("main") });
  const broadcaster = yield* Twitch.Account("broadcaster");
  const obs = yield* OBS.Connection("main");
  yield* Twitch.ChannelPointsRedemption.subscribe(broadcaster, (e) =>
    Effect.gen(function* () {
      if (e.reward.title !== (yield* rewardTitle)) return;
      yield* obs.SetCurrentProgramScene({ sceneName: yield* scene });
    }),
  );
});
