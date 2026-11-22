import { describe, expect, it } from "@effect/vitest";
import {
  MidiDecoder,
  MidiEncodingError,
  encodeMessage,
  encodeRaw,
  parseMessage,
} from "../src/index.ts";

describe("MIDI protocol", () => {
  it("parses channel messages and maps channels to 1-16", () => {
    expect(parseMessage([0x90, 60, 100])).toEqual({
      type: "noteOn",
      channel: 1,
      note: 60,
      velocity: 100,
    });
    expect(parseMessage([0x80, 60, 0])).toEqual({
      type: "noteOff",
      channel: 1,
      note: 60,
      velocity: 0,
    });
    expect(parseMessage([0x93, 64, 127])).toEqual({
      type: "noteOn",
      channel: 4,
      note: 64,
      velocity: 127,
    });
    // Note On with velocity 0 is the running-status form of Note Off.
    expect(parseMessage([0x92, 61, 0])).toEqual({
      type: "noteOff",
      channel: 3,
      note: 61,
      velocity: 0,
    });
    expect(parseMessage([0xb3, 7, 64])).toEqual({
      type: "controlChange",
      channel: 4,
      control: 7,
      value: 64,
    });
    expect(parseMessage([0xc2, 5])).toEqual({
      type: "programChange",
      channel: 3,
      program: 5,
    });
    expect(parseMessage([0xd2, 42])).toEqual({
      type: "channelAftertouch",
      channel: 3,
      pressure: 42,
    });
    expect(parseMessage([0xa2, 60, 90])).toEqual({
      type: "polyphonicAftertouch",
      channel: 3,
      note: 60,
      pressure: 90,
    });
    expect(parseMessage([0xe0, 0, 64])).toEqual({
      type: "pitchBend",
      channel: 1,
      value: 0,
    });
    expect(parseMessage([0xe0, 0, 32])).toEqual({
      type: "pitchBend",
      channel: 1,
      value: -4096,
    });
  });

  it("parses SysEx and rejects malformed messages", () => {
    expect(parseMessage([0xf0, 0x7d, 1, 2, 0xf7])).toEqual({
      type: "sysex",
      data: [0x7d, 1, 2],
    });
    expect(parseMessage([0xf0, 1, 2])).toBeUndefined();
    expect(parseMessage([0x90, 60])).toBeUndefined();
    expect(parseMessage([0x90, 60, 0x80])).toBeUndefined();
    expect(parseMessage([0xf8])).toBeUndefined();
  });

  it("handles running status, split messages and realtime bytes", () => {
    const decoder = new MidiDecoder();

    expect(decoder.push([0x90, 60, 100, 62, 100])).toEqual([
      {
        message: { type: "noteOn", channel: 1, note: 60, velocity: 100 },
        data: [0x90, 60, 100],
      },
      {
        message: { type: "noteOn", channel: 1, note: 62, velocity: 100 },
        data: [0x90, 62, 100],
      },
    ]);

    expect(decoder.push([0x91, 64])).toEqual([]);
    expect(decoder.push([0xf8, 50])).toEqual([
      {
        message: { type: "noteOn", channel: 2, note: 64, velocity: 50 },
        data: [0x91, 64, 50],
      },
    ]);

    // One-byte messages also keep running status: two program changes.
    expect(decoder.push([0xc0, 1, 2])).toEqual([
      {
        message: { type: "programChange", channel: 1, program: 1 },
        data: [0xc0, 1],
      },
      {
        message: { type: "programChange", channel: 1, program: 2 },
        data: [0xc0, 2],
      },
    ]);
  });

  it("decodes a SysEx transfer split across callbacks", () => {
    const decoder = new MidiDecoder();
    expect(decoder.push([0xf0, 1, 2])).toEqual([]);
    expect(decoder.push([3, 0xf7])).toEqual([
      { message: { type: "sysex", data: [1, 2, 3] }, data: [0xf0, 1, 2, 3, 0xf7] },
    ]);
  });

  it("encodes messages and validates ranges", () => {
    expect(
      encodeMessage({ type: "noteOn", channel: 1, note: 60, velocity: 100 }),
    ).toEqual([0x90, 60, 100]);
    expect(
      encodeMessage({ type: "noteOff", channel: 16, note: 0, velocity: 0 }),
    ).toEqual([0x8f, 0, 0]);
    expect(
      encodeMessage({ type: "controlChange", channel: 4, control: 7, value: 64 }),
    ).toEqual([0xb3, 7, 64]);
    expect(encodeMessage({ type: "programChange", channel: 3, program: 5 })).toEqual([
      0xc2, 5,
    ]);
    expect(encodeMessage({ type: "pitchBend", channel: 1, value: 0 })).toEqual([
      0xe0, 0, 64,
    ]);
    expect(encodeMessage({ type: "pitchBend", channel: 1, value: -8192 })).toEqual([
      0xe0, 0, 0,
    ]);
    expect(encodeMessage({ type: "pitchBend", channel: 1, value: 8191 })).toEqual([
      0xe0, 127, 127,
    ]);

    expect(() => encodeMessage({ type: "noteOn", channel: 0, note: 60, velocity: 1 })).toThrow(
      MidiEncodingError,
    );
    expect(() => encodeMessage({ type: "noteOn", channel: 1, note: 128, velocity: 1 })).toThrow(
      MidiEncodingError,
    );
  });

  it("validates raw messages", () => {
    expect(encodeRaw([0x90, 60, 100])).toEqual([0x90, 60, 100]);
    expect(() => encodeRaw([])).toThrow(MidiEncodingError);
    expect(() => encodeRaw([60, 100])).toThrow(MidiEncodingError);
    expect(() => encodeRaw([0x90, 300])).toThrow(MidiEncodingError);
  });
});
