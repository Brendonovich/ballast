import * as Ballast from "@ballast/core";
import * as VTS from "@ballast/module-vtube-studio";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const hotkey = yield* Ballast.Param.string("hotkey", {
    title: "Hotkey",
    options: VTS.hotkeys("main"),
  });
  const vts = yield* VTS.Connection("main");

  yield* VTS.HotkeyTriggered.subscribe(
    vts,
    (event) =>
      Effect.log(
        "hotkey " + event.hotkeyName + " (" + event.hotkeyAction + ") on " + event.modelName,
      ),
    { ignoreHotkeysTriggeredByAPI: true },
  );

  yield* Ballast.run(
    Effect.gen(function* () {
      const name = yield* hotkey;
      yield* Effect.log("triggering hotkey " + name);
      yield* vts.HotkeyTrigger({ hotkeyID: name });
    }),
  );
});
