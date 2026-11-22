import * as Keyboard from "@ballast/module-keyboard";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const keyboard = yield* Keyboard.Connection("main");
  const tap = yield* Keyboard.Tap(keyboard);

  yield* Keyboard.Hotkey.subscribe(
    keyboard,
    (event) =>
      Effect.gen(function* () {
        yield* Effect.log(`hotkey ${event.combo}`);
        yield* tap({ key: "F2" });
      }),
    { keys: ["Ctrl", "Shift", "F1"] },
  );

  yield* Keyboard.KeyDown.subscribe(keyboard, (event) =>
    Effect.log(`key ${event.key} down`),
  );
});
