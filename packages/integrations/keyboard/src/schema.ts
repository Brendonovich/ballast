import { Schema } from "effect";
import type { ModifierFlags } from "./keys.ts";
import { keyNames } from "./keys.ts";
import type { HotkeyState } from "./hotkey.ts";

export const KeyNameSchema = Schema.Literals(keyNames);
export type KeyName = Schema.Schema.Type<typeof KeyNameSchema>;

export const ModifierFlagsSchema = Schema.Struct({
  ctrl: Schema.Boolean,
  shift: Schema.Boolean,
  alt: Schema.Boolean,
  meta: Schema.Boolean,
});

export const KeyEventPayloadSchema = Schema.Struct({
  key: KeyNameSchema,
  /** The libuiohook keycode, useful for logging or matching outside this package. */
  code: Schema.Number,
  ctrl: Schema.Boolean,
  shift: Schema.Boolean,
  alt: Schema.Boolean,
  meta: Schema.Boolean,
  /** Milliseconds since the Unix epoch when the driver saw the event. */
  at: Schema.Number,
});
export interface KeyEventPayload extends ModifierFlags {
  readonly key: KeyName;
  readonly code: number;
  readonly at: number;
}

export const HotkeyPayloadSchema = Schema.Struct({
  key: KeyNameSchema,
  code: Schema.Number,
  /** Canonical combo, e.g. `Ctrl+Shift+F1`. */
  combo: Schema.String,
  state: Schema.Literals(["down", "up"]),
  ctrl: Schema.Boolean,
  shift: Schema.Boolean,
  alt: Schema.Boolean,
  meta: Schema.Boolean,
  at: Schema.Number,
});
export interface HotkeyPayload extends ModifierFlags {
  readonly key: KeyName;
  readonly code: number;
  readonly combo: string;
  readonly state: HotkeyState;
  readonly at: number;
}

export const TapInputSchema = Schema.Struct({
  key: KeyNameSchema,
  /** Modifier keys to hold while tapping, in any order. */
  modifiers: Schema.optionalKey(Schema.Array(KeyNameSchema)),
});
export interface TapInput {
  readonly key: KeyName;
  readonly modifiers?: ReadonlyArray<KeyName>;
}

export const ToggleInputSchema = Schema.Struct({
  key: KeyNameSchema,
  state: Schema.Literals(["down", "up"]),
});
export interface ToggleInput {
  readonly key: KeyName;
  readonly state: "down" | "up";
}

export const RequestOutputSchema = Schema.Struct({ ok: Schema.Boolean });
export interface RequestOutput {
  readonly ok: boolean;
}
