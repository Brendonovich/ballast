import * as Ballast from "@ballast/core";
import * as Midi from "@ballast/module-midi";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const midi = yield* Midi.Connection("controller");
  const output = yield* Ballast.Param.string("output", {
    title: "MIDI output",
    options: Midi.outputs("controller"),
  });
  const sendNote = yield* Midi.SendNoteOn(midi);

  yield* Midi.ControlChange.subscribe("control-change", midi, (event) =>
    Effect.gen(function* () {
      if (event.control !== 7) return;
      yield* sendNote({
        device: yield* output,
        channel: event.channel,
        note: 60,
        velocity: 100,
      });
    }),
  );

  yield* Midi.RawMessage.subscribe("raw-message", midi, (event) =>
    Effect.log(`raw ${event.data.join(" ")}`),
  );
});
