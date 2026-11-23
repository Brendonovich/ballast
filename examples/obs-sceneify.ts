import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "@ballast/module-sceneify";
import { Effect, Schema } from "effect";

class MediaSource extends Sceneify.InputType("ffmpeg_source", {
  local_file: Schema.String,
  looping: Schema.Boolean,
}) {}

class Text extends Sceneify.InputType("text_gdiplus_v3", { text: Schema.String }) {}

class ColorCorrection extends Sceneify.FilterType("color_filter_v2", {
  saturation: Schema.Number,
}) {}

const camera = Sceneify.Input.declare(MediaSource, {
  name: "Camera",
  settings: { local_file: "C:\\Stream\\camera.mp4", looping: true },
  filters: {
    hype: { type: ColorCorrection, name: "Hype", settings: { saturation: 1 }, enabled: false },
  },
});

const alerts = Sceneify.Scene.declare({
  name: "Alerts",
  items: {
    camera: { source: camera, index: 0 },
    banner: {
      source: Sceneify.Input.declare(Text, { name: "Alert Banner", settings: { text: "" } }),
      enabled: false,
      transform: { positionX: 960, positionY: 70 },
      index: 1,
    },
  },
});

export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  const message = yield* Ballast.Param.string("message", { title: "Banner text", default: "BRB" });
  const sceneify = yield* Sceneify.make(obs);
  const scene = sceneify.scene(alerts);

  // Declared scenes sync on first use, inside a handler, never in init.
  yield* OBS.CurrentProgramSceneChanged.subscribe("scene-changed", obs, (event) =>
    Effect.gen(function* () {
      const alertsScene = yield* scene.get;
      const live = event.sceneName === alerts.name;
      yield* alertsScene.item("camera").input.filter("hype").setEnabled(live);

      const banner = alertsScene.item("banner");
      yield* banner.input.setSettings({ text: yield* message });
      yield* banner.setEnabled(live);
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message))),
  );
}) satisfies Ballast.Project;
