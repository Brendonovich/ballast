import { Effect } from "effect";
import * as VTS from "../../src/index.ts";

/** Plan must kill this: init may declare a request, never call it. */
export default Effect.gen(function* () {
    const vts = yield* VTS.Connection("main");
    yield* vts.ModelLoad({ modelID: "model-1" });
});
