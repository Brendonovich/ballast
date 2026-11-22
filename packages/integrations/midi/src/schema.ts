import { Schema } from "effect";

export const NoteOnPayloadSchema = Schema.Struct({
  channel: Schema.Int,
  note: Schema.Int,
  velocity: Schema.Int,
});
export interface NoteOnPayload {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
}

export const NoteOffPayloadSchema = Schema.Struct({
  channel: Schema.Int,
  note: Schema.Int,
  velocity: Schema.Int,
});
export interface NoteOffPayload {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
}

export const ControlChangePayloadSchema = Schema.Struct({
  channel: Schema.Int,
  control: Schema.Int,
  value: Schema.Int,
});
export interface ControlChangePayload {
  readonly channel: number;
  readonly control: number;
  readonly value: number;
}

export const ProgramChangePayloadSchema = Schema.Struct({
  channel: Schema.Int,
  program: Schema.Int,
});
export interface ProgramChangePayload {
  readonly channel: number;
  readonly program: number;
}

export const PitchBendPayloadSchema = Schema.Struct({
  channel: Schema.Int,
  value: Schema.Int,
});
export interface PitchBendPayload {
  readonly channel: number;
  readonly value: number;
}

export const RawMessagePayloadSchema = Schema.Struct({
  data: Schema.Array(Schema.Int),
  channel: Schema.optionalKey(Schema.Int),
});
export interface RawMessagePayload {
  readonly data: ReadonlyArray<number>;
  readonly channel?: number;
}

export const RequestOutputSchema = Schema.Struct({ ok: Schema.Boolean });
export interface RequestOutput {
  readonly ok: boolean;
}

const device = { device: Schema.optionalKey(Schema.String) } as const;

export const NoteOnInputSchema = Schema.Struct({
  channel: Schema.Int,
  note: Schema.Int,
  velocity: Schema.Int,
  ...device,
});
export interface NoteOnInput {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  /** MIDI output port name. Defaults to the connection's configured output. */
  readonly device?: string;
}

export const NoteOffInputSchema = Schema.Struct({
  channel: Schema.Int,
  note: Schema.Int,
  velocity: Schema.Int,
  ...device,
});
export interface NoteOffInput {
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  readonly device?: string;
}

export const ControlChangeInputSchema = Schema.Struct({
  channel: Schema.Int,
  control: Schema.Int,
  value: Schema.Int,
  ...device,
});
export interface ControlChangeInput {
  readonly channel: number;
  readonly control: number;
  readonly value: number;
  readonly device?: string;
}

export const ProgramChangeInputSchema = Schema.Struct({
  channel: Schema.Int,
  program: Schema.Int,
  ...device,
});
export interface ProgramChangeInput {
  readonly channel: number;
  readonly program: number;
  readonly device?: string;
}

export const PitchBendInputSchema = Schema.Struct({
  channel: Schema.Int,
  value: Schema.Int,
  ...device,
});
export interface PitchBendInput {
  readonly channel: number;
  readonly value: number;
  readonly device?: string;
}

export const RawInputSchema = Schema.Struct({
  data: Schema.Array(Schema.Int),
  ...device,
});
export interface RawInput {
  readonly data: ReadonlyArray<number>;
  readonly device?: string;
}
