import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyboardBackend } from "@ballast/module-keyboard/driver";
import type {
  KeyboardBackendService,
  NativeKeyEvent,
} from "@ballast/module-keyboard/driver";
import { layerWith as keyboardDriverLayerWith } from "@ballast/module-keyboard/driver";
import { MidiBackend } from "@ballast/module-midi/driver";
import type { MidiBackendService } from "@ballast/module-midi/driver";
import { layerWith as midiDriverLayerWith } from "@ballast/module-midi/driver";

const keyEvent = (type: "keydown" | "keyup", keycode: number): NativeKeyEvent => ({
  type,
  keycode,
  time: Date.now(),
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});

const keyboardBackend: KeyboardBackendService = {
  platform: process.platform,
  permission: Effect.succeed("granted"),
  listen: (onEvent) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("1000 millis");
            onEvent(keyEvent("keydown", 0x003b));
            yield* Effect.sleep("50 millis");
            onEvent(keyEvent("keyup", 0x003b));
          }),
        ),
      );
    }),
  keyTap: () => Effect.void,
  keyToggle: () => Effect.void,
};

const midiBackend: MidiBackendService = {
  platform: process.platform,
  ports: Effect.succeed({ inputs: ["Fake Controller"], outputs: ["Fake Synth"] }),
  openInput: (_name, onMessage) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("1000 millis");
            onMessage([0x90, 60, 100]);
          }),
        ),
      );
    }),
  openOutput: () =>
    Effect.succeed({
      send: () => Effect.void,
    }),
};

/** Dev/test input drivers: native addons are replaced with deterministic fakes. */
export const devKeyboardLayer = keyboardDriverLayerWith(
  Layer.succeed(KeyboardBackend, keyboardBackend),
);

export const devMidiLayer = midiDriverLayerWith(Layer.succeed(MidiBackend, midiBackend));
