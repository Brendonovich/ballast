import { Effect } from "effect";
import * as Keyboard from "../../src/index.ts";

/** Plan must kill this: init may declare a request, never call it. */
export default Effect.gen(function* () {
    const keyboard = yield* Keyboard.Connection("main");
    const tap = yield* Keyboard.Tap(keyboard);
    yield* tap({ key: "F1" });
});
