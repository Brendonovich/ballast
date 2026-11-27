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

describe("Sceneify on an OBS connection", () => {
  it.effect("re-syncing a declared scene creates nothing new", () =>
    Effect.gen(function* () {
      const mock = MockOBSSocket.make();
      const sceneify = yield* connect(mock);

      yield* sceneify.sync(main).pipe(Ballast.provideRuntime);

      const before = creates(mock);
      yield* sceneify.sync(main).pipe(Ballast.provideRuntime);
      expect(creates(mock)).toBe(before);
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
