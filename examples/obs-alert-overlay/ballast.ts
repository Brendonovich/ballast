// An alert overlay built as a Ballast artifact and declared directly in OBS.
// The artifact handle exposes its read-only URL as a plain string during init,
// so an ordinary Sceneify browser source can use it with no I/O.
import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "@ballast/module-sceneify";
import { Effect } from "effect";

export const title = "OBS alert overlay";

export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");

  const overlay = yield* Ballast.Artifact("alerts", {
    title: "Alert overlay",
    description: "Transparent NEW FOLLOWER alert rendered by an OBS browser source.",
    entry: "./artifacts/alerts/main.ts",
    transparent: true,
  });

  const alerts = Sceneify.Scene.declare({
    name: "Alerts",
    items: {
      overlay: {
        source: Sceneify.Input.declare(Sceneify.BrowserSource, {
          name: "Alert Overlay",
          settings: {
            // overlay.url is the stable, read-only, transparent page URL.
            url: overlay.url,
            width: 1920,
            height: 1080,
            css: "html, body { background: transparent; }",
            // Keep the page alive while OBS shows another scene, and let OBS
            // restart it when the source becomes active again after an error.
            shutdown: false,
            restart_when_active: true,
          },
        }),
        index: 0,
      },
    },
  });

  const sceneify = yield* Sceneify.make(obs);
  const alertsScene = sceneify.scene(alerts);

  // Sceneify syncs on first use, so creating the scene and its browser source
  // happens here (a run), never in init.
  yield* Ballast.run(
    "sync-alerts-scene",
    Effect.gen(function* () {
      yield* alertsScene.get;
      yield* Effect.log("OBS scene \"Alerts\" ready; Alert Overlay loads " + overlay.url);
    }).pipe(Effect.catch((error) => Effect.logWarning("Alerts scene sync failed: " + error.message))),
  );
}) satisfies Ballast.Project;
