import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const broadcaster = yield* Twitch.Account("broadcaster");

    yield* Twitch.ChannelPointsRedemptionUpdate.subscribe(
      "redemption-update",
      broadcaster,
      () => Effect.void,
      { rewardId: "reward-1" },
    );
    yield* Twitch.HypeTrainBegin.subscribe("hype-train", broadcaster, () => Effect.void);
    yield* Twitch.PollEnd.subscribe("poll", broadcaster, () => Effect.void);
    yield* Twitch.PredictionLock.subscribe("prediction", broadcaster, () => Effect.void);
    yield* Twitch.ChannelUpdate.subscribe("channel", broadcaster, () => Effect.void);
    yield* Twitch.SubscriptionGift.subscribe("gift", broadcaster, () => Effect.void);

    yield* broadcaster.helix("endPoll");
    yield* broadcaster.helix("sendAnnouncement");
    yield* broadcaster.helix("banUser");
});
