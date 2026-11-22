import * as Ballast from "@ballast/core";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Ballast.Script(
  "helix-plan",
  Effect.gen(function* () {
    const broadcaster = yield* Twitch.Account("broadcaster");
    yield* broadcaster.helix("sendChatMessage");
  }),
);
