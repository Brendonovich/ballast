import { describe, expect, it } from "@effect/vitest";
import * as Ballast from "@ballast/core";
import { MockOBSSocket } from "@sceneify/core-rewrite";
import { Effect, Layer, Schema } from "effect";
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "../src/index.ts";

/**
 * A runtime RequestHost that sends requests to Sceneify's in-memory OBS the
 * way the agent and worker do: the driver decodes input with the request
 * schema, failures come back as strings the worker turns into defects, and
 * the worker decodes the output schema.
 */
const mockHost = (mock: ReturnType<typeof MockOBSSocket.make>) =>
  Ballast.RequestHost.of({
    client: () => Effect.die(new Error("not used")),
    granted: (ref) => (input) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownSync(ref.inputSchema!)(input ?? {});
        const output = yield* mock.service
          .call(ref.request as never, decoded as never)
          .pipe(Effect.mapError((error) => error.message), Effect.orDie);
        return Schema.decodeUnknownSync(ref.outputSchema!)(output ?? {});
      }) as never,
  });

const connect = (mock: ReturnType<typeof MockOBSSocket.make>) =>
  OBS.Connection("main").pipe(
    Effect.flatMap(Sceneify.make),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Ballast.RequestHost, mockHost(mock)),
        Layer.succeed(Ballast.ScriptPhase, "runtime"),
      ),
    ),
  );

class Color extends Sceneify.InputType("color_source_v3", {
  color: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
}) {}

class Text extends Sceneify.InputType("text_gdiplus_v3", { text: Schema.String }) {}

class Blur extends Sceneify.FilterType("blur_filter", { size: Schema.Number }) {}

const background = Sceneify.Input.declare(Color, {
  name: "Background",
  settings: { color: 0xff000000, width: 1920, height: 1080 },
  filters: { blur: { type: Blur, name: "Blur", settings: { size: 4 }, enabled: false } },
});

const main = Sceneify.Scene.declare({
  name: "Main",
  items: {
    background: { source: background, index: 0 },
    title: {
      source: Sceneify.Input.declare(Text, { name: "Title", settings: { text: "hello" } }),
      enabled: false,
      transform: { positionX: 960, positionY: 70 },
      index: 1,
    },
  },
});

const creates = (mock: ReturnType<typeof MockOBSSocket.make>) =>
  mock.calls.filter((call) => call.requestType.startsWith("Create")).length;

const overlayUrl =
  "http://127.0.0.1:47831/a/a1.demo.mac123/alerts/index.html?background=transparent";

const overlay = {
  name: "alerts",
  url: overlayUrl,
  transparent: true,
} satisfies Ballast.ArtifactHandle;

describe("Sceneify browser sources", () => {
  it.effect("creates an artifact browser source from the handle URL", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make();
      const sceneify = yield* connect(mock);

      const source = Sceneify.Input.declare(Sceneify.BrowserSource, {
        name: "Alert Overlay",
        settings: {
          url: overlay.url,
          width: 1920,
          height: 1080,
          css: "html, body { background: transparent; }",
          shutdown: false,
          restart_when_active: true,
          fps_custom: true,
          fps: 60,
        },
      });

      expect(source.type.kind).toBe("browser_source");

      const scene = Sceneify.Scene.declare({
        name: "Alerts",
        items: { overlay: { source, index: 0 } },
      });
      yield* sceneify.sync(scene).pipe(Ballast.provideRuntime);

      const input = mock.snapshot().inputs.find((value) => value.name === "Alert Overlay");
      expect(input?.kind).toBe("browser_source");
      expect(input?.settings).toMatchObject({
        url: overlayUrl,
        width: 1920,
        height: 1080,
        css: "html, body { background: transparent; }",
        shutdown: false,
        restart_when_active: true,
        fps_custom: true,
        fps: 60,
      });
    }),
  );
});

describe("Sceneify on an OBS connection", () => {
  it.effect("creates a declared scene and tracks it in private settings", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make();
      const sceneify = yield* connect(mock);

      const scene = yield* sceneify.sync(main).pipe(Ballast.provideRuntime);

      const state = mock.snapshot();
      expect(state.scenes.map((s) => s.name)).toEqual(["Main"]);
      expect(state.inputs.map((i) => [i.name, i.kind])).toEqual([
        ["Background", "color_source_v3"],
        ["Title", "text_gdiplus_v3"],
      ]);
      expect(mock.calls.some((call) => call.requestType === "SetSourcePrivateSettings")).toBe(true);
      expect(scene.item("title").input.name).toBe("Title");

      // A second sync finds everything Sceneify made and creates nothing.
      const before = creates(mock);
      yield* sceneify.sync(main).pipe(Ballast.provideRuntime);
      expect(creates(mock)).toBe(before);
    }),
  );

  it.effect("drives the synced scene through the connection", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make();
      const sceneify = yield* connect(mock);
      const handle = sceneify.scene(main);

      yield* Effect.gen(function* () {
        const scene = yield* handle.get;
        yield* scene.item("title").setEnabled(true);
        yield* scene.item("title").input.setSettings({ text: "updated" });
        yield* scene.item("background").input.filter("blur").setEnabled(true);

        const alert = yield* scene.createItem({ type: Text, name: "Alert", settings: { text: "!" } });
        yield* alert.remove();
      }).pipe(Ballast.provideRuntime);

      const state = mock.snapshot();
      const title = state.scenes[0]!.items.find((item) => item.sourceName === "Title")!;
      expect(title.enabled).toBe(true);
      expect(state.inputs.find((i) => i.name === "Title")!.settings).toMatchObject({ text: "updated" });
      expect(state.inputs.find((i) => i.name === "Background")!.filters[0]!.enabled).toBe(true);
      expect(state.scenes[0]!.items.some((item) => item.sourceName === "Alert")).toBe(false);
    }),
  );

  it.effect("syncs a handle once until asked again", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make();
      const sceneify = yield* connect(mock);
      const handle = sceneify.scene(main);
      const sceneLists = () => mock.calls.filter((call) => call.requestType === "GetSceneList").length;

      const first = yield* handle.get.pipe(Ballast.provideRuntime);
      const lists = sceneLists();
      const second = yield* handle.get.pipe(Ballast.provideRuntime);
      expect(second).toBe(first);
      expect(sceneLists()).toBe(lists);

      yield* handle.sync.pipe(Ballast.provideRuntime);
      expect(sceneLists()).toBeGreaterThan(lists);
    }),
  );

  it.effect("reports OBS failures as OBSError", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make({
        failures: [{ requestType: "CreateScene", message: "disk full" }],
      });
      const sceneify = yield* connect(mock);
      const error = yield* sceneify.sync(main).pipe(Ballast.provideRuntime, Effect.flip);
      expect(error._tag).toBe("OBSError");
      expect(error.message).toContain("disk full");
    }),
  );

  it.effect("refuses to claim a source made by hand", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make({
        inputs: [{ name: "Background", kind: "color_source_v3" }],
      });
      const sceneify = yield* connect(mock);
      const error = yield* sceneify.sync(main).pipe(Ballast.provideRuntime, Effect.flip);
      expect(error._tag).toBe("NameConflictError");
    }),
  );
});
