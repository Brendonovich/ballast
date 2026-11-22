import { Effect } from "effect";
import * as Midi from "../../src/index.ts";

/** Plan must kill this: init may declare a request, never call it. */
export default Effect.gen(function* () {
    const midi = yield* Midi.Connection("controller");
    const send = yield* Midi.SendNoteOn(midi);
    yield* send({ channel: 1, note: 60, velocity: 100 });
});
