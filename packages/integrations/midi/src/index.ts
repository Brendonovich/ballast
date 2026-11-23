import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
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

export interface MidiClient extends Ballast.ConnectionRef<Integration> {
  readonly noteOn: (input: NoteOnInput) => Effect.Effect<RequestOutput>;
  readonly noteOff: (input: NoteOffInput) => Effect.Effect<RequestOutput>;
  readonly controlChange: (input: ControlChangeInput) => Effect.Effect<RequestOutput>;
  readonly programChange: (input: ProgramChangeInput) => Effect.Effect<RequestOutput>;
  readonly pitchBend: (input: PitchBendInput) => Effect.Effect<RequestOutput>;
  /** Send a complete raw message. The first byte must be a status byte. */
  readonly raw: (input: RawInput) => Effect.Effect<RequestOutput>;
}

const call = <A, B>(
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<Integration>,
  request: string,
  inputSchema: Schema.Codec<A, unknown, never, never>,
  outputSchema: Schema.Codec<B, unknown, never, never>,
  input: A,
): Effect.Effect<B> =>
  host.granted<A, B>({
    integration: INTEGRATION,
    slot: connection.slot,
    request,
    scopes: [],
    key: INTEGRATION + "/" + connection.slot + "/" + request,
    inputSchema,
    outputSchema,
  })(input);

/**
 * Declare a logical MIDI device slot. The connection grants the whole
 * `midi/*` request namespace; output messages are methods on the returned
 * handle. The connection's `input` and `output` settings choose the physical
 * ports; the option sources below list them for the connection settings UI.
 */
export const Connection = (
  slot: string,
): Effect.Effect<MidiClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "local",
      requests: ["*"],
    });
    const host = yield* Ballast.RequestHost;
    return {
      ...connection,
      noteOn: (input) =>
        call(host, connection, "midi/noteOn", NoteOnInputSchema, RequestOutputSchema, input),
      noteOff: (input) =>
        call(host, connection, "midi/noteOff", NoteOffInputSchema, RequestOutputSchema, input),
      controlChange: (input) =>
        call(
          host,
          connection,
          "midi/controlChange",
          ControlChangeInputSchema,
          RequestOutputSchema,
          input,
        ),
      programChange: (input) =>
        call(
          host,
          connection,
          "midi/programChange",
          ProgramChangeInputSchema,
          RequestOutputSchema,
          input,
        ),
      pitchBend: (input) =>
        call(host, connection, "midi/pitchBend", PitchBendInputSchema, RequestOutputSchema, input),
      raw: (input) =>
        call(host, connection, "midi/raw", RawInputSchema, RequestOutputSchema, input),
    };
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

/** Dynamic string options backed by the machine's MIDI input ports. */
export const inputs = (
  connection: Ballast.ConnectionRef<Integration>,
): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot: connection.slot,
  source: "inputs",
});

/** Dynamic string options backed by the machine's MIDI output ports. */
export const outputs = (
  connection: Ballast.ConnectionRef<Integration>,
): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot: connection.slot,
  source: "outputs",
});
