import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const broadcaster = yield* Twitch.Account("broadcaster");
    const bot = yield* Twitch.Account("bot");

    yield* Twitch.ChannelPointsRedemption.subscribe(
      broadcaster,
      () => Effect.void,
      { rewardId: "reward-1" },
    );
    yield* Twitch.ChannelPointsRedemption.subscribe(
      broadcaster,
      () => Effect.void,
      { rewardId: "reward-2" },
    );
    yield* Twitch.ChatMessage.subscribe(bot, () => Effect.void, { broadcaster });
    yield* Twitch.Raid.subscribe(broadcaster, () => Effect.void, {
      direction: "outgoing",
    });
});
