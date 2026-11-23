import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
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

export interface KeyboardClient extends Ballast.ConnectionRef<Integration> {
  /** Tap a key once, optionally holding modifiers, on the streamer's machine. */
  readonly tap: (
    input: TapInput,
  ) => Effect.Effect<RequestOutput, never, Ballast.Runtime>;
  /** Press or release a key without a matching tap, for push-to-talk style keys. */
  readonly toggle: (
    input: ToggleInput,
  ) => Effect.Effect<RequestOutput, never, Ballast.Runtime>;
}

const call = <A, B>(
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<Integration>,
  request: string,
  inputSchema: Schema.Codec<A, unknown, never, never>,
  outputSchema: Schema.Codec<B, unknown, never, never>,
  input: A,
): Effect.Effect<B, never, Ballast.Runtime> =>
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
 * Declare a global keyboard connection slot. The connection grants the whole
 * `keyboard/*` request namespace; synthetic key actions are methods on the
 * returned handle. The OS Accessibility permission is connection-wide.
 */
export const Connection = (
  slot: string,
): Effect.Effect<KeyboardClient, never, Ballast.RequestHost> =>
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
      tap: (input) =>
        call(host, connection, "keyboard/tap", TapInputSchema, RequestOutputSchema, input),
      toggle: (input) =>
        call(host, connection, "keyboard/toggle", ToggleInputSchema, RequestOutputSchema, input),
    };
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
        Ballast.withUnitHandler(name, (event) =>
          Ballast.provideRuntime(handler(event)),
        ),
        name,
        Ballast.captureSource(1),
      ),
    );
  },
};

/**
 * Dynamic string options for a key picker. The agent resolves them from
 * `Keyboard.keyNames`; useful for a settings UI that edits hotkey options.
 */
export const keys = (
  connection: Ballast.ConnectionRef<Integration>,
): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot: connection.slot,
  source: "keys",
});
