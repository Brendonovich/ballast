/**
 * MIDI wire format, kept pure and independent of the native binding. The
 * driver feeds bytes from {@link MidiDecoder} into the typed topics; request
 * handlers use {@link encodeMessage} and {@link encodeRaw}.
 *
 * Channels are exposed as 1-16, matching device manuals and DAWs.
 */

export const MAX_MESSAGE_BYTES = 65_536;

const Status = {
  noteOff: 0x8,
  noteOn: 0x9,
  polyphonicAftertouch: 0x0a,
  controlChange: 0x0b,
  programChange: 0x0c,
  channelAftertouch: 0x0d,
  pitchBend: 0x0e,
} as const;

export type MidiMessage =
  | {
      readonly type: "noteOn";
      readonly channel: number;
      readonly note: number;
      readonly velocity: number;
    }
  | {
      readonly type: "noteOff";
      readonly channel: number;
      readonly note: number;
      readonly velocity: number;
    }
  | {
      readonly type: "polyphonicAftertouch";
      readonly channel: number;
      readonly note: number;
      readonly pressure: number;
    }
  | {
      readonly type: "controlChange";
      readonly channel: number;
      readonly control: number;
      readonly value: number;
    }
  | {
      readonly type: "programChange";
      readonly channel: number;
      readonly program: number;
    }
  | {
      readonly type: "channelAftertouch";
      readonly channel: number;
      readonly pressure: number;
    }
  /** Signed bend, -8192 to 8191 with 0 at center. */
  | { readonly type: "pitchBend"; readonly channel: number; readonly value: number }
  /** Payload between the F0 and F7 framing bytes. */
  | { readonly type: "sysex"; readonly data: ReadonlyArray<number> };

export type MidiMessageType = MidiMessage["type"];

export interface DecodedMidiMessage {
  readonly message: MidiMessage;
  /**
   * The complete message, including a status byte. Running status messages
   * are normalized so raw consumers always receive a well-formed message.
   */
  readonly data: ReadonlyArray<number>;
}

export class MidiEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiEncodingError";
  }
}

const isData = (byte: number | undefined): byte is number =>
  byte !== undefined && Number.isInteger(byte) && byte >= 0 && byte <= 0x7f;

const dataLength = (status: number): number => {
  const kind = status >> 4;
  return kind === Status.programChange || kind === Status.channelAftertouch ? 1 : 2;
};

/**
 * Parse one complete MIDI message. Returns `undefined` for realtime/system
 * messages this package does not model. A Note On with velocity 0 becomes a
 * Note Off, which is the standard running-status form.
 */
export const parseMessage = (data: ReadonlyArray<number>): MidiMessage | undefined => {
  const status = data[0];
  if (status === undefined) return undefined;

  if (status === 0xf0) {
    if (data.length < 2 || data[data.length - 1] !== 0xf7) return undefined;
    const payload = data.slice(1, -1);
    return payload.every(isData) ? { type: "sysex", data: payload } : undefined;
  }

  if (status < 0x80 || status >= 0xf0) return undefined;

  const kind = status >> 4;
  const channel = (status & 0x0f) + 1;
  const expected = dataLength(status);
  if (data.length !== expected + 1) return undefined;

  const first = data[1];
  const second = data[2];
  if (!isData(first)) return undefined;

  if (kind === Status.programChange) {
    return second === undefined
      ? { type: "programChange", channel, program: first }
      : undefined;
  }
  if (kind === Status.channelAftertouch) {
    return second === undefined
      ? { type: "channelAftertouch", channel, pressure: first }
      : undefined;
  }
  if (!isData(second)) return undefined;

  switch (kind) {
    case Status.noteOn:
      return second === 0
        ? { type: "noteOff", channel, note: first, velocity: 0 }
        : { type: "noteOn", channel, note: first, velocity: second };
    case Status.noteOff:
      return { type: "noteOff", channel, note: first, velocity: second };
    case Status.polyphonicAftertouch:
      return { type: "polyphonicAftertouch", channel, note: first, pressure: second };
    case Status.controlChange:
      return { type: "controlChange", channel, control: first, value: second };
    case Status.pitchBend:
      return { type: "pitchBend", channel, value: ((second << 7) | first) - 8192 };
    default:
      return undefined;
  }
};

const integer = (value: number, min: number, max: number, label: string): number => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MidiEncodingError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const data7 = (value: number, label: string): number => integer(value, 0, 127, label);

const statusByte = (kind: number, channel: number): number =>
  (kind << 4) | (integer(channel, 1, 16, "Channel") - 1);

/** Encode a modelled message, validating channel and data ranges. */
export const encodeMessage = (message: MidiMessage): ReadonlyArray<number> => {
  switch (message.type) {
    case "noteOn":
    case "noteOff":
      return [
        statusByte(
          message.type === "noteOn" ? Status.noteOn : Status.noteOff,
          message.channel,
        ),
        data7(message.note, "Note"),
        data7(message.velocity, "Velocity"),
      ];
    case "polyphonicAftertouch":
      return [
        statusByte(Status.polyphonicAftertouch, message.channel),
        data7(message.note, "Note"),
        data7(message.pressure, "Pressure"),
      ];
    case "controlChange":
      return [
        statusByte(Status.controlChange, message.channel),
        data7(message.control, "Control"),
        data7(message.value, "Value"),
      ];
    case "programChange":
      return [
        statusByte(Status.programChange, message.channel),
        data7(message.program, "Program"),
      ];
    case "channelAftertouch":
      return [
        statusByte(Status.channelAftertouch, message.channel),
        data7(message.pressure, "Pressure"),
      ];
    case "pitchBend": {
      const value = integer(message.value, -8192, 8191, "Bend") + 8192;
      return [statusByte(Status.pitchBend, message.channel), value & 0x7f, value >> 7];
    }
    case "sysex": {
      if (message.data.length > MAX_MESSAGE_BYTES - 2) {
        throw new MidiEncodingError(`SysEx payload exceeds ${MAX_MESSAGE_BYTES - 2} bytes`);
      }
      if (!message.data.every(isData)) {
        throw new MidiEncodingError(
          "SysEx bytes must be integers between 0 and 127; omit the F0/F7 framing bytes",
        );
      }
      return [0xf0, ...message.data, 0xf7];
    }
  }
};

/** Validate and copy a complete raw message. The first byte must be a status byte. */
export const encodeRaw = (data: ReadonlyArray<number>): ReadonlyArray<number> => {
  if (data.length === 0 || data.length > MAX_MESSAGE_BYTES) {
    throw new MidiEncodingError(`A MIDI message must contain 1 to ${MAX_MESSAGE_BYTES} bytes`);
  }
  if (!data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)) {
    throw new MidiEncodingError("MIDI bytes must be integers between 0 and 255");
  }
  const first = data[0];
  if (first === undefined || first < 0x80) {
    throw new MidiEncodingError("A MIDI message must start with a status byte (128-255)");
  }
  return [...data];
};

/**
 * A stateful MIDI byte-stream decoder. RtMidi normally delivers one complete
 * message per callback, but hardware and virtual ports can omit repeated
 * status bytes (running status), split messages across callbacks, or include
 * realtime bytes inside another message. This normalizes all of those into
 * complete messages with their status byte present.
 */
export class MidiDecoder {
  private status: number | undefined;
  private data: Array<number> = [];
  private sysex: Array<number> | undefined;

  reset(): void {
    this.status = undefined;
    this.data = [];
    this.sysex = undefined;
  }

  push(bytes: ReadonlyArray<number>): ReadonlyArray<DecodedMidiMessage> {
    const out: Array<DecodedMidiMessage> = [];

    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) continue;

      // Realtime messages (clock, active sensing, reset) may appear anywhere.
      if (byte >= 0xf8) continue;

      if (this.sysex !== undefined) {
        if (byte === 0xf7) {
          const message: MidiMessage = { type: "sysex", data: [...this.sysex] };
          out.push({ message, data: encodeMessage(message) });
          this.sysex = undefined;
          continue;
        }
        if (byte < 0x80) {
          this.sysex.push(byte);
          continue;
        }
        // Another status byte aborts an unfinished sysex message.
        this.sysex = undefined;
      }

      if (byte === 0xf0) {
        this.sysex = [];
        this.status = undefined;
        this.data = [];
        continue;
      }

      if (byte >= 0x80) {
        // System common messages are not modelled and reset running status.
        this.status = byte < 0xf0 ? byte : undefined;
        this.data = [];
        continue;
      }

      if (this.status === undefined) continue;
      this.data.push(byte);
      if (this.data.length < dataLength(this.status)) continue;

      const message = parseMessage([this.status, ...this.data]);
      this.data = [];
      if (message !== undefined) out.push({ message, data: encodeMessage(message) });
      // Running status: keep this.status for the next data bytes.
    }

    return out;
  }
}
