/**
 * Physical key names shared by the native hook and the script SDK. Keys are
 * identified by physical position, not by the character they type, so `A` is
 * the same key on QWERTY and AZERTY layouts. Left and right modifiers share a
 * name.
 *
 * Everything here is pure: importing this module never loads the native
 * addon. `src/driver/native.ts` owns the lazy `uiohook-napi` import.
 */

export const modifiers = ["Ctrl", "Shift", "Alt", "Meta"] as const;
export type Modifier = (typeof modifiers)[number];

export const keyNames = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "Ctrl",
  "Shift",
  "Alt",
  "Meta",
  "Space",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "CapsLock",
  "Insert",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
] as const;

export type KeyName = (typeof keyNames)[number];

const aliases: Readonly<Record<string, KeyName>> = {
  control: "Ctrl",
  option: "Alt",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  windows: "Meta",
  super: "Meta",
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  ins: "Insert",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pgup: "PageUp",
  pgdn: "PageDown",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
};

const byLowercase = new Map<string, KeyName>([
  ...keyNames.map((name) => [name.toLowerCase(), name] as const),
  ...Object.entries(aliases),
]);

/** Resolve a user-entered key name case-insensitively, accepting common aliases. */
export const parseKey = (input: string): KeyName | undefined =>
  byLowercase.get(input.trim().toLowerCase());

export const isModifier = (key: string): key is Modifier =>
  (modifiers as ReadonlyArray<string>).includes(key);

/**
 * libuiohook scan codes, from `UiohookKey` in uiohook-napi. Kept here so key
 * names and simulation requests can be resolved without loading the addon.
 * The first entry for a name is its canonical code.
 */
const uiohookCodes: ReadonlyArray<readonly [number, KeyName]> = [
  [0x000e, "Backspace"],
  [0x000f, "Tab"],
  [0x001c, "Enter"],
  [0x003a, "CapsLock"],
  [0x0001, "Escape"],
  [0x0039, "Space"],
  [0x0e49, "PageUp"],
  [0x0e51, "PageDown"],
  [0x0e4f, "End"],
  [0x0e47, "Home"],
  [0xe04b, "ArrowLeft"],
  [0xe048, "ArrowUp"],
  [0xe04d, "ArrowRight"],
  [0xe050, "ArrowDown"],
  [0x0e52, "Insert"],
  [0x0e53, "Delete"],
  [0x000b, "0"],
  [0x0002, "1"],
  [0x0003, "2"],
  [0x0004, "3"],
  [0x0005, "4"],
  [0x0006, "5"],
  [0x0007, "6"],
  [0x0008, "7"],
  [0x0009, "8"],
  [0x000a, "9"],
  [0x001e, "A"],
  [0x0030, "B"],
  [0x002e, "C"],
  [0x0020, "D"],
  [0x0012, "E"],
  [0x0021, "F"],
  [0x0022, "G"],
  [0x0023, "H"],
  [0x0017, "I"],
  [0x0024, "J"],
  [0x0025, "K"],
  [0x0026, "L"],
  [0x0032, "M"],
  [0x0031, "N"],
  [0x0018, "O"],
  [0x0019, "P"],
  [0x0010, "Q"],
  [0x0013, "R"],
  [0x001f, "S"],
  [0x0014, "T"],
  [0x0016, "U"],
  [0x002f, "V"],
  [0x0011, "W"],
  [0x002d, "X"],
  [0x0015, "Y"],
  [0x002c, "Z"],
  [0x0052, "Numpad0"],
  [0x004f, "Numpad1"],
  [0x0050, "Numpad2"],
  [0x0051, "Numpad3"],
  [0x004b, "Numpad4"],
  [0x004c, "Numpad5"],
  [0x004d, "Numpad6"],
  [0x0047, "Numpad7"],
  [0x0048, "Numpad8"],
  [0x0049, "Numpad9"],
  [0x0037, "NumpadMultiply"],
  [0x004e, "NumpadAdd"],
  [0x004a, "NumpadSubtract"],
  [0x0053, "NumpadDecimal"],
  [0x0e35, "NumpadDivide"],
  [0x0e1c, "NumpadEnter"],
  // Numpad keys with Num Lock off report navigation codes; keep their physical names.
  [0xee4f, "Numpad1"],
  [0xee50, "Numpad2"],
  [0xee51, "Numpad3"],
  [0xee4b, "Numpad4"],
  [0xee4c, "Numpad5"],
  [0xee4d, "Numpad6"],
  [0xee47, "Numpad7"],
  [0xee48, "Numpad8"],
  [0xee49, "Numpad9"],
  [0xee52, "Numpad0"],
  [0xee53, "NumpadDecimal"],
  [0x003b, "F1"],
  [0x003c, "F2"],
  [0x003d, "F3"],
  [0x003e, "F4"],
  [0x003f, "F5"],
  [0x0040, "F6"],
  [0x0041, "F7"],
  [0x0042, "F8"],
  [0x0043, "F9"],
  [0x0044, "F10"],
  [0x0057, "F11"],
  [0x0058, "F12"],
  [0x005b, "F13"],
  [0x005c, "F14"],
  [0x005d, "F15"],
  [0x0063, "F16"],
  [0x0064, "F17"],
  [0x0065, "F18"],
  [0x0066, "F19"],
  [0x0067, "F20"],
  [0x0068, "F21"],
  [0x0069, "F22"],
  [0x006a, "F23"],
  [0x006b, "F24"],
  [0x0027, "Semicolon"],
  [0x000d, "Equal"],
  [0x0033, "Comma"],
  [0x000c, "Minus"],
  [0x0034, "Period"],
  [0x0035, "Slash"],
  [0x0029, "Backquote"],
  [0x001a, "BracketLeft"],
  [0x002b, "Backslash"],
  [0x001b, "BracketRight"],
  [0x0028, "Quote"],
  [0x001d, "Ctrl"],
  [0x0e1d, "Ctrl"],
  [0x0038, "Alt"],
  [0x0e38, "Alt"],
  [0x002a, "Shift"],
  [0x0036, "Shift"],
  [0x0e5b, "Meta"],
  [0x0e5c, "Meta"],
  [0x0045, "NumLock"],
  [0x0046, "ScrollLock"],
  [0x0e37, "PrintScreen"],
];

const canonicalCodes = new Map<KeyName, number>();
for (const [code, key] of uiohookCodes) {
  if (!canonicalCodes.has(key)) canonicalCodes.set(key, code);
}

const namesByCode = new Map<number, KeyName>(uiohookCodes);

/** The libuiohook keycode used to simulate a key, when the key has one. */
export const uiohookKeyCode = (key: KeyName): number | undefined => canonicalCodes.get(key);

/** Map a libuiohook keycode from the hook to a key name. */
export const keyFromUiohookCode = (code: number): KeyName | undefined => namesByCode.get(code);

export interface ModifierFlags {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export const NO_MODIFIERS: ModifierFlags = {
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
};

/** The modifier flags for a set of modifier names. Other key names are ignored. */
export const flagsForKeys = (keys: ReadonlyArray<string>): ModifierFlags => ({
  ctrl: keys.includes("Ctrl"),
  shift: keys.includes("Shift"),
  alt: keys.includes("Alt"),
  meta: keys.includes("Meta"),
});

export const sameModifiers = (left: ModifierFlags, right: ModifierFlags): boolean =>
  left.ctrl === right.ctrl &&
  left.shift === right.shift &&
  left.alt === right.alt &&
  left.meta === right.meta;
