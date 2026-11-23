// Everything the project does to OBS, on top of the declared layout. Handlers
// call these; nothing here runs in init except creating handles.
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "@ballast/module-sceneify";
import { Deferred, Effect, Semaphore } from "effect";
import * as Layout from "./obs/layout.ts";
import * as T from "./obs/types.ts";

export interface Alert {
  readonly video: string;
  readonly volumeDb: number;
  readonly headline: string;
}

export const sceneKeys = ["starting", "gameplay", "chatting", "brb"] as const;
export type SceneKey = (typeof sceneKeys)[number];

export const isSceneKey = (value: string): value is SceneKey =>
  (sceneKeys as ReadonlyArray<string>).includes(value);

/** Longest an alert may hold the queue if OBS never reports the video ended. */
const alertTimeout = "30 seconds";

export const makeStage = (obs: OBS.ObsClient) =>
  Effect.gen(function* () {
    const sceneify = yield* Sceneify.make(obs);
    const scenes = {
      starting: sceneify.scene(Layout.starting),
      gameplay: sceneify.scene(Layout.gameplay),
      chatting: sceneify.scene(Layout.chatting),
      brb: sceneify.scene(Layout.brb),
    };

    // Alerts play one at a time; each waits for its video to finish.
    const alertQueue = yield* Semaphore.make(1);
    const playing = new Map<string, Deferred.Deferred<void>>();
    let alertCount = 0;

    yield* OBS.MediaInputPlaybackEnded.subscribe("alert-video-ended", obs, ({ inputName }) =>
      Effect.suspend(() => {
        const done = playing.get(inputName);
        return done === undefined ? Effect.void : Deferred.succeed(done, undefined);
      }).pipe(Effect.asVoid),
    );

    /** Sync every scene, then apply the settings that come from params. */
    const setup = (settings: { readonly music: string; readonly title: string }) =>
      Effect.gen(function* () {
        for (const handle of Object.values(scenes)) {
          yield* handle.get;
        }
        const starting = yield* scenes.starting.get;
        yield* starting.item("music").input.setSettings({ local_file: settings.music });
        yield* setTitle(settings.title);
        yield* Effect.log("OBS layout ready: " + Object.values(scenes).map((s) => s.declaration.name).join(", "));
      });

    const show = (key: SceneKey) =>
      Effect.flatMap(scenes[key].get, (scene) => scene.makeProgramScene);

    const setTitle = (text: string) =>
      Effect.flatMap(scenes.gameplay.get, (scene) => scene.item("title").input.setSettings({ text }));

    const setHype = (on: boolean) =>
      Effect.flatMap(scenes.gameplay.get, (scene) =>
        scene.item("camera").input.filter("hype").setEnabled(on),
      );

    /** Alerts play on whichever content scene is live, Gameplay otherwise. */
    const alertScene = Effect.gen(function* () {
      // A raw request on the same connection as the declared scenes.
      const { sceneName } = yield* obs.GetCurrentProgramScene();
      return sceneName === Layout.chatting.name ? yield* scenes.chatting.get : yield* scenes.gameplay.get;
    });

    const playAlert = (alert: Alert) =>
      alertQueue.withPermits(1)(
        Effect.gen(function* () {
          const scene = yield* alertScene;
          const name = "Alert " + ++alertCount;
          const done = yield* Deferred.make<void>();
          playing.set(name, done);

          const video = yield* scene.createItem({
            type: T.MediaSource,
            name,
            settings: { local_file: alert.video, looping: false, close_when_inactive: true },
          });
          const banner = scene.item("banner");

          yield* Effect.gen(function* () {
            yield* video.input.setAudioMonitorType("monitorAndOutput");
            yield* video.input.setVolume({ db: alert.volumeDb });
            yield* video.setTransform({ alignment: Sceneify.SceneItem.Alignment.center, positionX: 960, positionY: 540 });
            yield* banner.input.setSettings({ text: alert.headline });
            yield* banner.setEnabled(true);
            yield* Deferred.await(done).pipe(Effect.timeoutOption(alertTimeout));
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                playing.delete(name);
                yield* banner.setEnabled(false);
                yield* video.remove();
              }).pipe(Effect.ignore),
            ),
          );
        }),
      );

    return { scenes, setup, show, setTitle, setHype, playAlert };
  });

export type Stage = Effect.Success<ReturnType<typeof makeStage>>;

/** Log a failed OBS action instead of failing the handler. */
export const logFailure = <A, E extends { readonly message: string }, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.logWarning(label + " failed: " + error.message)),
  );
