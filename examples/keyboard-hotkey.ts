import * as Keyboard from "@ballast/module-keyboard";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const keyboard = yield* Keyboard.Connection("main");

  yield* Keyboard.Hotkey.subscribe(
    "hotkey",
    keyboard,
    (event) =>
      Effect.gen(function* () {
        yield* Effect.log(`hotkey ${event.combo}`);
        yield* keyboard.tap({ key: "F2" });
      }),
    { keys: ["Ctrl", "Shift", "F1"] },
  );

  yield* Keyboard.KeyDown.subscribe("key-down", keyboard, (event) =>
    Effect.log(`key ${event.key} down`),
  );
});
