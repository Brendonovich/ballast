import { describe, expect, it } from "@effect/vitest";
import * as Fake from "@ballast/fake";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import * as Effect from "effect/Effect";

/**
 * Type-only assertions. Not run: the second OBS subscription is intentionally
 * invalid and must stay a type error.
 */
export const topicConnectionTypes = Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  const obs = yield* OBS.Connection("main");

  yield* Fake.Tick.subscribe("tick", fake, (tick) => Effect.log(String(tick.n)));
  yield* OBS.CurrentProgramSceneChanged.subscribe("scene-changed", obs, (event) =>
    Effect.log(event.sceneName),
  );

  // @ts-expect-error an OBS topic requires an OBS connection, not a Fake one
  yield* OBS.CurrentProgramSceneChanged.subscribe("wrong", fake, (event) =>
    Effect.log(event.sceneName),
  );

  const broadcaster = yield* Twitch.Account("broadcaster");
  yield* Twitch.ChannelPointsRedemption.subscribe("redemption", broadcaster, (event) =>
    Effect.log(event.reward.title),
  );
  // @ts-expect-error a Twitch topic requires a Twitch connection, not a Fake one
  yield* Twitch.ChannelPointsRedemption.subscribe("wrong", fake, (event) =>
    Effect.log(event.reward.title),
  );

  const sendChat = yield* broadcaster.helix("sendChatMessage");
  yield* sendChat({
    broadcaster_id: "1337",
    sender_id: "1337",
    message: "hi",
  });
  // @ts-expect-error Helix input fields are typed; message is required
  yield* sendChat({ broadcaster_id: "1337", sender_id: "1337" });
});

describe("topic subscription types", () => {
  it("rejects a topic subscription on another integration's connection (checked by typecheck)", () => {
    expect(typeof topicConnectionTypes).toBe("object");
  });
});
