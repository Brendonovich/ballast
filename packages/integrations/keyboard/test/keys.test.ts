import { describe, expect, it } from "@effect/vitest";
import {
  flagsForKeys,
  hotkeyTopicKey,
  keyFromUiohookCode,
  keyNames,
  parseHotkeyCondition,
  parseHotkeyKeys,
  parseKey,
  sameModifiers,
  uiohookKeyCode,
} from "../src/index.ts";

describe("keyboard key names", () => {
  it("parses canonical names case-insensitively and accepts aliases", () => {
    expect(parseKey("a")).toBe("A");
    expect(parseKey("  f1 ")).toBe("F1");
    expect(parseKey("control")).toBe("Ctrl");
    expect(parseKey("cmd")).toBe("Meta");
    expect(parseKey("esc")).toBe("Escape");
    expect(parseKey("/")).toBe("Slash");
    expect(parseKey("nope")).toBeUndefined();
  });

  it("maps every key name to a libuiohook code and back", () => {
    for (const key of keyNames) {
      const code = uiohookKeyCode(key);
      expect(code, key).toBeDefined();
      if (code !== undefined) expect(keyFromUiohookCode(code), key).toBe(key);
    }
  });

  it("maps left and right modifiers to the shared name", () => {
    expect(keyFromUiohookCode(0x0e1d)).toBe("Ctrl");
    expect(keyFromUiohookCode(0x0036)).toBe("Shift");
    expect(keyFromUiohookCode(0x0e38)).toBe("Alt");
    expect(keyFromUiohookCode(0x0e5c)).toBe("Meta");
  });
});

describe("keyboard hotkeys", () => {
  it("canonicalizes modifier order and reads a combo", () => {
    const parsed = parseHotkeyKeys(["F1", "Shift", "Ctrl"]);
    expect(parsed).toEqual({
      ok: true,
      filter: {
        modifiers: ["Ctrl", "Shift"],
        key: "F1",
        combo: "Ctrl+Shift+F1",
        state: "down",
      },
    });
  });

  it("supports aliases and the up edge", () => {
    const parsed = parseHotkeyKeys(["cmd", "k"], "up");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.filter.combo).toBe("Meta+K");
      expect(parsed.filter.state).toBe("up");
    }
  });

  it("rejects unknown keys, modifier-only combos and several main keys", () => {
    expect(parseHotkeyKeys(["Ctrl", "Nope"]).ok).toBe(false);
    expect(parseHotkeyKeys(["Ctrl", "Shift"]).ok).toBe(false);
    expect(parseHotkeyKeys(["A", "B"]).ok).toBe(false);
    expect(parseHotkeyKeys([], "down").ok).toBe(false);
    expect(parseHotkeyKeys(["F1"], "pressed").ok).toBe(false);
  });

  it("round-trips a manifest condition and keys each hotkey separately", () => {
    const parsed = parseHotkeyKeys(["Ctrl", "Shift", "F1"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const condition = { keys: parsed.filter.combo, state: parsed.filter.state };
    const reread = parseHotkeyCondition(condition);
    expect(reread).toEqual(parsed);
    expect(hotkeyTopicKey("main", parsed.filter)).toBe(
      "keyboard/main/keyboard/Hotkey#Ctrl+Shift+F1/down",
    );
  });

  it("matches modifiers exactly", () => {
    const expected = flagsForKeys(["Ctrl", "Shift"]);
    expect(sameModifiers(flagsForKeys(["Shift", "Ctrl"]), expected)).toBe(true);
    expect(sameModifiers(flagsForKeys(["Ctrl"]), expected)).toBe(false);
    expect(sameModifiers(flagsForKeys(["Ctrl", "Shift", "Alt"]), expected)).toBe(false);
  });
});
