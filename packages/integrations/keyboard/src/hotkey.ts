import type { TopicCondition } from "@ballast/core";
import { isModifier, keyNames, modifiers, parseKey } from "./keys.ts";
import type { KeyName, Modifier } from "./keys.ts";

export type HotkeyState = "down" | "up";

/**
 * A hotkey as declared by a subscription. The same value is written to the
 * manifest condition (`{ keys: "Ctrl+Shift+F1", state: "down" }`) and used by
 * the driver to filter native events.
 */
export interface HotkeyFilter {
  /** Modifiers in canonical order: Ctrl, Shift, Alt, Meta. */
  readonly modifiers: ReadonlyArray<Modifier>;
  /** The one non-modifier key that completes the combo. */
  readonly key: KeyName;
  /** Canonical display form, e.g. `Ctrl+Shift+F1`. */
  readonly combo: string;
  readonly state: HotkeyState;
}

export type HotkeyParse =
  | { readonly ok: true; readonly filter: HotkeyFilter }
  | { readonly ok: false; readonly message: string };

const parseState = (value: string | undefined): HotkeyState | undefined =>
  value === undefined ? "down" : value === "down" || value === "up" ? value : undefined;

/**
 * Turn a set of key names such as `["Ctrl", "Shift", "F1"]` into a filter.
 * Exactly one non-modifier key is required; at least one key is required.
 */
export const parseHotkeyKeys = (
  input: ReadonlyArray<string>,
  state: string | undefined = "down",
): HotkeyParse => {
  const parsedState = parseState(state);
  if (parsedState === undefined) {
    return { ok: false, message: `Hotkey state must be "down" or "up", got "${state}"` };
  }
  if (input.length === 0) {
    return { ok: false, message: "A hotkey needs at least one key" };
  }

  const resolved: Array<KeyName> = [];
  for (const entry of input) {
    const key = parseKey(entry);
    if (key === undefined) {
      return {
        ok: false,
        message: `Unknown hotkey key "${entry}". Use a name from Keyboard.keyNames.`,
      };
    }
    if (!resolved.includes(key)) resolved.push(key);
  }

  const heldModifiers = modifiers.filter((modifier) => resolved.includes(modifier));
  const keys = resolved.filter((key) => !isModifier(key));
  if (keys.length !== 1) {
    return {
      ok: false,
      message:
        keys.length === 0
          ? "A hotkey needs one non-modifier key (such as F1 or A), not only modifiers"
          : `A hotkey can only have one non-modifier key, got ${keys.join(", ")}`,
    };
  }

  const key = keys[0];
  if (key === undefined) {
    return { ok: false, message: "A hotkey needs one non-modifier key" };
  }

  return {
    ok: true,
    filter: {
      modifiers: heldModifiers,
      key,
      combo: [...heldModifiers, key].join("+"),
      state: parsedState,
    },
  };
};

/** Read a hotkey filter back from a manifest topic condition. */
export const parseHotkeyCondition = (condition: TopicCondition | undefined): HotkeyParse => {
  if (condition === undefined) {
    return {
      ok: false,
      message: "Keyboard.Hotkey subscriptions need a { keys: [...] } option so the driver can filter",
    };
  }
  const keys = condition["keys"];
  if (typeof keys !== "string" || keys.length === 0) {
    return { ok: false, message: "Hotkey condition is missing its keys" };
  }
  const state = condition["state"];
  return parseHotkeyKeys(keys.split("+"), typeof state === "string" ? state : undefined);
};

/** The manifest condition for a filter. Only strings are allowed in conditions. */
export const hotkeyCondition = (filter: HotkeyFilter): TopicCondition => ({
  keys: filter.combo,
  state: filter.state,
});

/**
 * The agent bus key for one hotkey subscription. A plain topic key would make
 * every hotkey handler receive every hotkey, so the canonical combo and state
 * are part of the key. The driver derives the same keys from the manifest.
 */
export const hotkeyTopicKey = (slot: string, filter: HotkeyFilter): string =>
  `keyboard/${slot}/keyboard/Hotkey#${filter.combo}/${filter.state}`;

/** All known key names, for the `keys` param option source. */
export const keyOptions: ReadonlyArray<string> = keyNames;
