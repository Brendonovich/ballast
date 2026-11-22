import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import { INTEGRATION } from "./constants.ts";
import {
  ControlChangeInputSchema,
  ControlChangePayloadSchema,
  NoteOffInputSchema,
  NoteOffPayloadSchema,
  NoteOnInputSchema,
  NoteOnPayloadSchema,
  PitchBendInputSchema,
  PitchBendPayloadSchema,
  ProgramChangeInputSchema,
  ProgramChangePayloadSchema,
  RawInputSchema,
  RawMessagePayloadSchema,
  RequestOutputSchema,
} from "./schema.ts";
import type {
  ControlChangeInput,
  ControlChangePayload,
  NoteOffInput,
  NoteOffPayload,
  NoteOnInput,
  NoteOnPayload,
  PitchBendInput,
  PitchBendPayload,
  ProgramChangeInput,
  ProgramChangePayload,
  RawInput,
  RawMessagePayload,
  RequestOutput,
} from "./schema.ts";

export { INTEGRATION } from "./constants.ts";
export { MAX_MESSAGE_BYTES, MidiDecoder, MidiEncodingError, encodeMessage, encodeRaw, parseMessage } from "./messages.ts";
export type { DecodedMidiMessage, MidiMessage, MidiMessageType } from "./messages.ts";
export {
  ControlChangeInputSchema,
  ControlChangePayloadSchema,
  NoteOffInputSchema,
  NoteOffPayloadSchema,
  NoteOnInputSchema,
  NoteOnPayloadSchema,
  PitchBendInputSchema,
  PitchBendPayloadSchema,
  ProgramChangeInputSchema,
  ProgramChangePayloadSchema,
  RawInputSchema,
  RawMessagePayloadSchema,
  RequestOutputSchema,
} from "./schema.ts";
export type {
  ControlChangeInput,
  ControlChangePayload,
  NoteOffInput,
  NoteOffPayload,
  NoteOnInput,
  NoteOnPayload,
  PitchBendInput,
  PitchBendPayload,
  ProgramChangeInput,
  ProgramChangePayload,
  RawInput,
  RawMessagePayload,
  RequestOutput,
} from "./schema.ts";

export type Integration = typeof INTEGRATION;

/**
 * Declare a logical MIDI device slot. The connection's `input` and `output`
 * settings choose the physical ports; the option sources below list them for
 * the connection settings UI.
 */
export const Connection = (
  slot: string,
): Effect.Effect<Ballast.ConnectionRef<Integration>> =>
  Ballast.Connection<Integration>({
    integration: INTEGRATION,
    slot,
    location: "local",
  });

export const NoteOn = Ballast.Topic<NoteOnPayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/NoteOn`,
  schema: NoteOnPayloadSchema,
});

/** Also fires for Note On messages with velocity 0. */
export const NoteOff = Ballast.Topic<NoteOffPayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/NoteOff`,
  schema: NoteOffPayloadSchema,
});

export const ControlChange = Ballast.Topic<ControlChangePayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/ControlChange`,
  schema: ControlChangePayloadSchema,
});

export const ProgramChange = Ballast.Topic<ProgramChangePayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/ProgramChange`,
  schema: ProgramChangePayloadSchema,
});

/** Signed bend, -8192 to 8191 with 0 at center. */
export const PitchBend = Ballast.Topic<PitchBendPayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/PitchBend`,
  schema: PitchBendPayloadSchema,
});

/** Every message from the input, including ones without a typed topic. */
export const RawMessage = Ballast.Topic<RawMessagePayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/RawMessage`,
  schema: RawMessagePayloadSchema,
});

export const SendNoteOn = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<NoteOnInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<NoteOnInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/noteOn",
    inputSchema: NoteOnInputSchema,
    outputSchema: RequestOutputSchema,
  });

export const SendNoteOff = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<NoteOffInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<NoteOffInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/noteOff",
    inputSchema: NoteOffInputSchema,
    outputSchema: RequestOutputSchema,
  });

export const SendControlChange = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<
  Ballast.RequestClient<ControlChangeInput, RequestOutput>,
  never,
  Ballast.RequestHost
> =>
  Ballast.Request<ControlChangeInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/controlChange",
    inputSchema: ControlChangeInputSchema,
    outputSchema: RequestOutputSchema,
  });

export const SendProgramChange = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<
  Ballast.RequestClient<ProgramChangeInput, RequestOutput>,
  never,
  Ballast.RequestHost
> =>
  Ballast.Request<ProgramChangeInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/programChange",
    inputSchema: ProgramChangeInputSchema,
    outputSchema: RequestOutputSchema,
  });

export const SendPitchBend = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<PitchBendInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<PitchBendInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/pitchBend",
    inputSchema: PitchBendInputSchema,
    outputSchema: RequestOutputSchema,
  });

/** Send a complete raw message. The first byte must be a status byte. */
export const SendRaw = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<RawInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<RawInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "midi/raw",
    inputSchema: RawInputSchema,
    outputSchema: RequestOutputSchema,
  });

/** Dynamic string options backed by the machine's MIDI input ports. */
export const inputs = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: "inputs",
});

/** Dynamic string options backed by the machine's MIDI output ports. */
export const outputs = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: "outputs",
});
