# @ballast/module-midi

MIDI input and output for devices attached to the streamer's machine.

## Script API

```ts
import * as Midi from "@ballast/module-midi";

const midi = yield* Midi.Connection("controller");
const output = yield* Ballast.Param.string("output", { options: Midi.outputs("controller") });

yield* Midi.NoteOn.subscribe(midi, (event) =>
  Effect.log(`note ${event.note} on channel ${event.channel}`),
);
yield* Midi.RawMessage.subscribe(midi, (event) => Effect.log(event.data));

const sendNote = yield* Midi.SendNoteOn(midi);
yield* sendNote({ device: yield* output, channel: 1, note: 60, velocity: 100 });
```

Topics: `NoteOn`, `NoteOff`, `ControlChange`, `ProgramChange`, `PitchBend`,
`RawMessage`. Channels are 1-16. Note On with velocity 0 becomes NoteOff (the
standard running-status form). Pitch bend is signed (-8192..8191, 0 center).
Raw messages always include their status byte; running-status input is
normalized by `MidiDecoder`.

Requests: `SendNoteOn`, `SendNoteOff`, `SendControlChange`,
`SendProgramChange`, `SendPitchBend`, `SendRaw`. Each accepts an optional
`device` output-port name; without it the driver uses the connection's
configured output. `SendRaw` requires a status byte and validates every byte.

`Midi.inputs(slot)` and `Midi.outputs(slot)` are `ParamOptionSource`s backed by
the live port list, for a device picker. Duplicate port names get ` #2`,
` #3`, ... so they stay addressable.

## Driver (`@ballast/module-midi/driver`)

Standalone Effect service with native access behind `MidiBackend`:
`connect({ slot, input?, output?, topics })`, `disconnect`, `events`,
`status`, `request`, `options("inputs" | "outputs")`. Tests use
`layerWith(fakeBackend)`. No dependency on `apps/agent`.

The service's ConnectionManager should pass the selected input/output port
names from connection settings and the manifest's topics. Bus keys are
`midi/<slot>/<topic>`. `events` already carries the key and payload.

## Native addon

`@julusian/midi` 3.8.1 (RtMidi) is imported through its `/lazy` entry inside
each operation and `verifyLibraryLoaded()` turns a missing binding into a
clear `DriverError`.

- Prebuilds use `node-napi-v7` for macOS arm64/x64, Windows x64/ia32/arm64,
  Linux x64/arm64/arm and x64-musl. N-API is ABI-stable, so no Electron
  rebuild is needed; verified under Electron 44.9.1 `ELECTRON_RUN_AS_NODE=1`
  (loading, zero ports listed on this machine).
- In a packaged Electron app, ship `@julusian/midi` under
  `node_modules` (or at least its `prebuilds` directory) outside asar.
- No OS permission is required. On Windows only one application can open an
  input port at a time. macOS CoreMIDI may not report devices plugged in after
  startup; reconnect the connection (or restart the service) to rescan.
