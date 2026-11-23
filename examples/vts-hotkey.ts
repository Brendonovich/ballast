import * as Ballast from "@ballast/core";
import * as VTS from "@ballast/module-vtube-studio";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const vts = yield* VTS.Connection("main");
  const hotkey = yield* Ballast.Param.string("hotkey", {
    title: "Hotkey",
    options: VTS.hotkeys(vts),
  });

  yield* VTS.HotkeyTriggered.subscribe(
    "hotkey-triggered",
    vts,
    (event) =>
      Effect.log(
        "hotkey " + event.hotkeyName + " (" + event.hotkeyAction + ") on " + event.modelName,
      ),
    { ignoreHotkeysTriggeredByAPI: true },
  );

  yield* Ballast.run("hotkey-loop",
    Effect.gen(function* () {
      const name = yield* hotkey;
      yield* Effect.log("triggering hotkey " + name);
      yield* vts.HotkeyTrigger({ hotkeyID: name });
    }),
  );
}) satisfies Ballast.Project;
