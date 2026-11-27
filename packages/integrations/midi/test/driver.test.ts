import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Driver, MidiBackend, layerWith } from "../src/driver/index.ts";
import type { MidiBackendService, MidiOutputPort } from "../src/driver/index.ts";

interface FakeOutput extends MidiOutputPort {
  readonly name: string;
  readonly sent: Array<ReadonlyArray<number>>;
}

interface FakeBackend {
  readonly layer: Layer.Layer<MidiBackend>;
  readonly message: (data: ReadonlyArray<number>) => void;
  readonly inputs: Map<string, (data: ReadonlyArray<number>) => void>;
  readonly outputs: Map<string, FakeOutput>;
}

const INPUTS = ["Launchpad MIDI", "Keyboard"];
const OUTPUTS = ["Launchpad MIDI", "Synth"];

const makeFake = (): FakeBackend => {
  const inputs = new Map<string, (data: ReadonlyArray<number>) => void>();
  const outputs = new Map<string, FakeOutput>();

  const service: MidiBackendService = {
    platform: "test",
    ports: Effect.succeed({ inputs: INPUTS, outputs: OUTPUTS }),
    openInput: (name, onMessage) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          inputs.set(name, onMessage);
        }),
        () =>
          Effect.sync(() => {
            inputs.delete(name);
          }),
      ),
    openOutput: (name) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const output: FakeOutput = {
            name,
            sent: [],
            send: (data) =>
              Effect.sync(() => {
                output.sent.push([...data]);
              }),
          };
          outputs.set(name, output);
          return output;
        }),
        () =>
          Effect.sync(() => {
            outputs.delete(name);
          }),
      ),
  };

  return {
    layer: Layer.succeed(MidiBackend, service),
    message: (data) => {
      for (const listener of inputs.values()) listener(data);
    },
    inputs,
    outputs,
  };
};

const collect = <A>(stream: Stream.Stream<A>, count: number) =>
  stream.pipe(Stream.take(count), Stream.runCollect, Effect.map((chunk) => Array.from(chunk)));

describe("MIDI driver", () => {
  it.live("maps parsed messages to typed topics and raw messages", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const events = yield* collect(driver.events, 4).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");

      yield* driver.connect({
        slot: "controller",
        input: "Launchpad MIDI",
        output: "Launchpad MIDI",
        topics: [
          { topic: "midi/NoteOn" },
          { topic: "midi/NoteOff" },
          { topic: "midi/ControlChange" },
          { topic: "midi/ProgramChange" },
          { topic: "midi/PitchBend" },
          { topic: "midi/RawMessage" },
        ],
      });

      fake.message([0x93, 60, 100]);
      fake.message([0x83, 60, 0]);

      const result = yield* Fiber.join(events);
      expect(result.map((event) => event.topic)).toEqual([
        "midi/RawMessage",
        "midi/NoteOn",
        "midi/RawMessage",
        "midi/NoteOff",
      ]);
      expect(result[0]?.payload).toEqual({ data: [0x93, 60, 100], channel: 4 });
      expect(result[1]?.payload).toEqual({ channel: 4, note: 60, velocity: 100 });
      expect(result[3]?.payload).toEqual({ channel: 4, note: 60, velocity: 0 });
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("maps control change, program change and pitch bend", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const events = yield* collect(driver.events, 3).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      yield* driver.connect({
        slot: "controller",
        input: "Launchpad MIDI",
        topics: [
          { topic: "midi/ControlChange" },
          { topic: "midi/ProgramChange" },
          { topic: "midi/PitchBend" },
        ],
      });

      fake.message([0xb3, 7, 64]);
      fake.message([0xc2, 5]);
      fake.message([0xe0, 0, 32]);

      const result = yield* Fiber.join(events);
      expect(result.map((event) => event.payload)).toEqual([
        { channel: 4, control: 7, value: 64 },
        { channel: 3, program: 5 },
        { channel: 1, value: -4096 },
      ]);
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("sends to the default output and opens a named device output on demand", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.connect({ slot: "controller", output: "Launchpad MIDI", topics: [] });

      yield* driver.request("midi/noteOn", { channel: 1, note: 60, velocity: 100 });
      expect(fake.outputs.get("Launchpad MIDI")?.sent).toEqual([[0x90, 60, 100]]);

      yield* driver.request("midi/controlChange", {
        device: "Synth",
        channel: 1,
        control: 1,
        value: 2,
      });
      expect(fake.outputs.get("Synth")?.sent).toEqual([[0xb0, 1, 2]]);
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("rejects out-of-range send requests", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.connect({ slot: "controller", output: "Launchpad MIDI", topics: [] });

      const invalid = yield* driver
        .request("midi/noteOn", { channel: 17, note: 60, velocity: 100 })
        .pipe(Effect.flip);
      expect(invalid.message).toContain("Channel");
      const invalidRaw = yield* driver.request("midi/raw", { data: [1, 2] }).pipe(Effect.flip);
      expect(invalidRaw.message).toContain("status byte");
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("closes every opened port on disconnect", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.connect({
        slot: "controller",
        input: "Launchpad MIDI",
        output: "Launchpad MIDI",
        topics: [{ topic: "midi/NoteOn" }],
      });
      yield* driver.request("midi/noteOn", { device: "Synth", channel: 1, note: 60, velocity: 1 });

      yield* driver.disconnect;
      expect(fake.inputs.size).toBe(0);
      expect(fake.outputs.size).toBe(0);
      expect((yield* driver.status).state).toBe("disconnected");
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("fails to connect when the input is unselected, ports are missing or a topic is unknown", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const missingInput = yield* driver
        .connect({ slot: "controller", topics: [{ topic: "midi/NoteOn" }] })
        .pipe(Effect.flip);
      expect(missingInput.message).toContain("not selected");

      const unknownInput = yield* driver
        .connect({
          slot: "controller",
          input: "Missing",
          topics: [{ topic: "midi/NoteOn" }],
        })
        .pipe(Effect.flip);
      expect(unknownInput.message).toContain("not connected");

      const unknownOutput = yield* driver
        .connect({ slot: "controller", output: "Missing", topics: [] })
        .pipe(Effect.flip);
      expect(unknownOutput.message).toContain("not connected");

      const unknownTopic = yield* driver
        .connect({ slot: "controller", topics: [{ topic: "midi/Nope" }] })
        .pipe(Effect.flip);
      expect(unknownTopic.message).toContain("Unknown MIDI topic");
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });
});
