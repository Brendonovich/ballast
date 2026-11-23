/**
 * Realistic read-only source fixtures for `MockAgentLayer`. They are shown in
 * the Source tab and are intentionally close to the examples in this repo;
 * they are not executed by the mock.
 */
export const mockScriptSources: ReadonlyMap<string, string> = new Map([
  ["scripts/redeem-to-scene.ts", `import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const rewardTitle = yield* Ballast.Param.string("rewardTitle", {
      title: "Reward title",
      default: "Hydrate",
    });
    const broadcaster = yield* Twitch.Account("broadcaster");
    const obs = yield* OBS.Connection("main");
    const scene = yield* Ballast.Param.string("scene", {
      title: "Scene",
      options: OBS.scenes(obs),
    });
    const holdSeconds = yield* Ballast.Param.number("holdSeconds", {
      title: "Hold for (seconds)",
      default: 5,
    });

    yield* Twitch.ChannelPointsRedemption.subscribe("redemption", broadcaster, (event) =>
      Effect.gen(function* () {
        if (event.reward.title !== (yield* rewardTitle)) return;

        const target = yield* scene;
        yield* obs.SetCurrentProgramScene({ sceneName: target });
        yield* Effect.log("switched scene to " + target + " for " + event.user.login);

        const hold = yield* holdSeconds;
        if (hold > 0) {
          yield* Effect.sleep(hold + " seconds");
        }
      }),
    );
});
`],
  ["scripts/cheer-alert.ts", `import * as Ballast from "@ballast/core";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const message = yield* Ballast.Param.string("message", {
      title: "Chat message",
      default: "Thanks for the bits!",
    });
    const minBits = yield* Ballast.Param.number("minBits", {
      title: "Minimum bits",
      default: 100,
    });

    const broadcaster = yield* Twitch.Account("broadcaster");
    const sendMessage = yield* broadcaster.helix("sendChatMessage");

    yield* Twitch.Cheer.subscribe("cheer", broadcaster, (event) =>
      Effect.gen(function* () {
        if (event.bits < (yield* minBits)) return;
        yield* sendMessage({
          broadcaster_id: "1337",
          sender_id: "1337",
          message: yield* message,
        });
        yield* Effect.log(event.user.login + " cheered " + event.bits + " bits");
      }),
    );
});
`],
  ["scripts/tick-echo.ts", `import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const prefix = yield* Ballast.Param.string("prefix", {
      title: "Prefix",
      default: ">",
    });

    const fake = yield* Fake.Connection("main");

    yield* Fake.Tick.subscribe("tick", fake, (tick) =>
      Effect.gen(function* () {
        const text = (yield* prefix) + " tick " + tick.n;
        const { text: echoed } = yield* fake.echo({ text });
        yield* Effect.log(echoed);
      }),
    );
});
`],
  ["scripts/scene-rotation.ts", `import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const intervalSeconds = yield* Ballast.Param.number("intervalSeconds", {
      title: "Rotate every (seconds)",
      default: 30,
    });

    const obs = yield* OBS.Connection("secondary");

    yield* Ballast.run(
      "rotation",
      Effect.gen(function* () {
        const interval = yield* intervalSeconds;
        const { scenes } = yield* obs.GetSceneList();
        if (scenes.length === 0) return;

        let index = 0;
        yield* Effect.forever(
          Effect.gen(function* () {
            const next = scenes[index % scenes.length];
            index += 1;
            if (next === undefined) return;
            yield* obs.SetCurrentProgramScene({ sceneName: next.sceneName });
            yield* Effect.sleep(interval + " seconds");
          }),
        );
      }),
    );
});
`],
]);
