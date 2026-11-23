import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import { INTEGRATION } from "./constants.ts";
import {
  hotkeyCondition,
  hotkeyTopicKey,
  parseHotkeyKeys,
  type HotkeyFilter,
} from "./hotkey.ts";
import type { KeyName } from "./keys.ts";
import {
  HotkeyPayloadSchema,
  KeyEventPayloadSchema,
  RequestOutputSchema,
  TapInputSchema,
  ToggleInputSchema,
} from "./schema.ts";
import type {
  HotkeyPayload,
  KeyEventPayload,
  RequestOutput,
  TapInput,
  ToggleInput,
} from "./schema.ts";

export { INTEGRATION } from "./constants.ts";
export {
  HotkeyPayloadSchema,
  KeyEventPayloadSchema,
  KeyNameSchema,
  ModifierFlagsSchema,
  RequestOutputSchema,
  TapInputSchema,
  ToggleInputSchema,
} from "./schema.ts";
export type {
  HotkeyPayload,
  KeyEventPayload,
  KeyName,
  RequestOutput,
  TapInput,
  ToggleInput,
} from "./schema.ts";
export {
  NO_MODIFIERS,
  flagsForKeys,
  isModifier,
  keyFromUiohookCode,
  keyNames,
  modifiers,
  parseKey,
  sameModifiers,
  uiohookKeyCode,
} from "./keys.ts";
export type { Modifier, ModifierFlags } from "./keys.ts";
export {
  hotkeyCondition,
  hotkeyTopicKey,
  keyOptions,
  parseHotkeyCondition,
  parseHotkeyKeys,
} from "./hotkey.ts";
export type { HotkeyFilter, HotkeyParse, HotkeyState } from "./hotkey.ts";

export type Integration = typeof INTEGRATION;

/** Declare a global keyboard connection slot. */
export const Connection = (
  slot: string,
): Effect.Effect<Ballast.ConnectionRef<Integration>> =>
  Ballast.Connection<Integration>({
    integration: INTEGRATION,
    slot,
    location: "local",
  });

/**
 * Fires when any key is pressed. Holding a key does not repeat, and the
 * modifiers are the other modifier keys held at the moment of the press.
 */
export const KeyDown = Ballast.Topic<KeyEventPayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/KeyDown`,
  schema: KeyEventPayloadSchema,
});

/**
 * Fires when a key is released. Modifiers are the ones held when the key was
 * pressed, so releasing Ctrl before K still reports Ctrl+K.
 */
export const KeyUp = Ballast.Topic<KeyEventPayload, Integration>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/KeyUp`,
  schema: KeyEventPayloadSchema,
});

export interface HotkeyOptions {
  /** Key names such as `["Ctrl", "Shift", "F1"]`. Exactly one non-modifier key. */
  readonly keys: ReadonlyArray<KeyName | string>;
  /** Which edge fires the handler. Defaults to `"down"`. */
  readonly state?: "down" | "up";
}

const hotkeyBase = Ballast.Topic<HotkeyPayload, Integration, HotkeyOptions>({
  integration: INTEGRATION,
  topic: `${INTEGRATION}/Hotkey`,
  schema: HotkeyPayloadSchema,
});

/**
 * Subscribe to a hotkey combo. The combo is recorded in the manifest as a
 * topic condition (`{ keys: "Ctrl+Shift+F1", state: "down" }`), so the driver
 * filters before delivery and two hotkeys on the same connection do not see
 * each other's events.
 *
 * Modifiers must match exactly: a Ctrl+F1 hotkey does not fire when Shift is
 * also held.
 */
export const Hotkey: Ballast.Topic<HotkeyPayload, Integration, HotkeyOptions> = {
  ...hotkeyBase,
  subscribe: (name, connection, handler, options) => {
    if (options === undefined) {
      return Effect.die(
        new Error('Keyboard.Hotkey.subscribe requires options: { keys: ["Ctrl", "F1"] }'),
      );
    }
    const parsed = parseHotkeyKeys(options.keys, options.state ?? "down");
    if (!parsed.ok) return Effect.die(new Error(parsed.message));

    const filter: HotkeyFilter = parsed.filter;
    const metadata: Ballast.TopicMetadata<HotkeyPayload, Integration> = {
      ...hotkeyBase,
      condition: hotkeyCondition(filter),
      key: (target) => hotkeyTopicKey(target.slot, filter),
    };

    return Effect.flatMap(Ballast.EventHost, (host) =>
      host.subscribe(
        metadata,
        connection,
        Ballast.withUnitHandler(name, handler),
        name,
        Ballast.captureSource(1),
      ),
    );
  },
};

/** Tap a key once, optionally holding modifiers, on the streamer's machine. */
export const Tap = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<TapInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<TapInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "keyboard/tap",
    inputSchema: TapInputSchema,
    outputSchema: RequestOutputSchema,
  });

/** Press or release a key without a matching tap, for push-to-talk style keys. */
export const Toggle = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<ToggleInput, RequestOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<ToggleInput, RequestOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "keyboard/toggle",
    inputSchema: ToggleInputSchema,
    outputSchema: RequestOutputSchema,
  });

/**
 * Dynamic string options for a key picker. The agent resolves them from
 * `Keyboard.keyNames`; useful for a settings UI that edits hotkey options.
 */
export const keys = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: "keys",
});
