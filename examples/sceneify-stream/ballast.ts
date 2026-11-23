// A stream run from declared OBS scenes: Sceneify keeps the layout in OBS
// matching src/obs/layout.ts, and Twitch events drive it.
import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect } from "effect";
import { logFailure, makeStage } from "./src/stage.ts";
import { wireTwitch } from "./src/twitch.ts";

export const title = "Sceneify stream";

const declareParams = Effect.gen(function* () {
  return {
    title: yield* Ballast.Param.string("title", { title: "Stream title", default: "Building things with Ballast" }),
    music: yield* Ballast.Param.string("music", {
      title: "Starting Soon music",
      default: "C:\\Stream\\music\\starting-soon.mp3",
    }),
    alertVideo: yield* Ballast.Param.string("alertVideo", {
      title: "Alert video",
      default: "C:\\Stream\\alerts\\alert.webm",
    }),
    raidVideo: yield* Ballast.Param.string("raidVideo", {
      title: "Raid video",
      default: "C:\\Stream\\alerts\\raid.webm",
    }),
    alertVolumeDb: yield* Ballast.Param.number("alertVolumeDb", { title: "Alert volume (dB)", default: -6 }),
    hypeBits: yield* Ballast.Param.number("hypeBits", { title: "Bits that start hype mode", default: 500 }),
    hypeMinutes: yield* Ballast.Param.number("hypeMinutes", { title: "Hype mode length (minutes)", default: 2 }),
    startingSoonMinutes: yield* Ballast.Param.number("startingSoonMinutes", {
      title: "Starting Soon length (minutes)",
      default: 5,
    }),
  };
});

export type Params = Effect.Success<typeof declareParams>;

export default Effect.gen(function* () {
  const params = yield* declareParams;
  const obs = yield* OBS.Connection("main");
  const broadcaster = yield* Twitch.Account("broadcaster");

  const stage = yield* makeStage(obs);
  yield* wireTwitch(broadcaster, stage, params);

  // Bring OBS in line with the layout as soon as the project starts.
  yield* Ballast.run(
    "sync-layout",
    logFailure(
      "layout sync",
      Effect.gen(function* () {
        yield* stage.setup({ music: yield* params.music, title: yield* params.title });
      }),
    ),
  );
}) satisfies Ballast.Project;
