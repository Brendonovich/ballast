import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const broadcaster = yield* Twitch.Account("broadcaster");
    yield* broadcaster.helix("sendChatMessage");
});
