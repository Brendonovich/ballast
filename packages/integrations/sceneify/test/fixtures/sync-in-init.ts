import { Effect } from "effect";
import * as OBS from "@ballast/module-obs";
import * as Sceneify from "../../src/index.ts";

const main = Sceneify.Scene.declare({ name: "Main", items: {} });

/** Plan must kill this too: syncing a declared scene sends requests. */
export default Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  const sceneify = yield* Sceneify.make(obs);
  yield* sceneify.sync(main);
});
