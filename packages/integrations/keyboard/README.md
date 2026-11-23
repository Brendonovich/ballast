# @ballast/module-keyboard

Global keyboard input and key simulation on the streamer's machine.

## Script API

```ts
import * as Keyboard from "@ballast/module-keyboard";

const keyboard = yield* Keyboard.Connection("main");

yield* Keyboard.KeyDown.subscribe("key-down", keyboard, (event) =>
  Effect.log(`${event.key} with ctrl=${event.ctrl}`),
);

yield* Keyboard.Hotkey.subscribe(
  "hotkey",
  keyboard,
  (event) => Effect.log(event.combo),
  { keys: ["Ctrl", "Shift", "F1"] },
);

yield* keyboard.tap({ key: "F1" });
yield* keyboard.toggle({ key: "A", state: "down" });
```

- `KeyDown` / `KeyUp` payloads: `{ key, code, ctrl, shift, alt, meta, at }`.
  `key` is a physical `KeyName`; aliases such as `Cmd`, `Esc` and `/` are
  accepted by `KeyName` parsing in hotkeys and options.
- `Hotkey.subscribe(connection, handler, { keys, state? })` records
  `condition: { keys: "Ctrl+Shift+F1", state: "down" }` in the manifest. The
  driver filters before delivery, so subscribing two hotkeys on one connection
  does not send each handler the other's combos. The bus key for a hotkey is
  `keyboard/<slot>/keyboard/Hotkey#<combo>/<state>`.
- **Exact modifiers**: Ctrl+F1 does not fire while Shift is also held. A key
  release reports the modifiers held at its press.
- `Keyboard.Connection` grants the whole `keyboard/*` namespace. The handle
  methods `tap` and `toggle` are backed by libuiohook's `keyTap` /
  `keyToggle`. `toggle` is a matching down/up pair for push-to-talk. The macOS
  Accessibility permission is connection-wide, not a per-request approval.
- `keys(keyboard)` takes the keyboard connection handle and returns a
  `ParamOptionSource` containing every `KeyName`.

## Driver (`@ballast/module-keyboard/driver`)

`Driver` is a standalone Effect service (`connect`, `disconnect`, `events`,
`status`, `request`, `options`) with the native addon behind
`KeyboardBackend`. Tests inject a fake backend with `layerWith`. The driver
does not import anything from `apps/agent`; the service's ConnectionManager
will adapt it.

`connect({ slot, topics, permission? })` takes the manifest topics for that
slot, including conditions. Each event carries the agent bus `key` (ordinary
topics are `keyboard/<slot>/<topic>`; hotkeys use the combo key above), so the
adapter can route it without recomputing conditions.

`status` reports `disconnected | connecting | listening | error`, the platform,
the permission state and a macOS hint. `request` returns `{ ok: true }`.

## Native addon

`uiohook-napi` 1.5.5 (libuiohook) is imported lazily inside `listen`, so a
missing prebuild is a connection error rather than a service crash.

- Prebuilds: `napi` for macOS arm64/x64, Windows x64/arm64 and Linux
  x64/arm64/loong64 (X11 only; Wayland is unsupported).
- N-API is ABI-stable. Verified loading under both plain Node 24 and the
  Electron 44.9.1 `ELECTRON_RUN_AS_NODE=1` runtime (Node 24.22, ABI 149)
  without rebuilding. In a packaged Electron app, keep `.node` files (and
  preferably the whole `uiohook-napi/prebuilds` directory) outside asar.
- macOS needs **Accessibility** (and commonly **Input Monitoring**) for the
  process running the service. `uIOhook.start()` succeeds without permission
  and simply delivers no events, so plain Node cannot detect it. The driver
  reports `permission: "unknown"` on macOS; pass `permission` from the Electron
  shell (`systemPreferences.isTrustedAccessibilityClient(false)`) or override
  `KeyboardBackend` to report the real state. Input Monitoring has no public
  Electron query; a native helper is needed for that half.
- Windows has no extra permission. Some anti-cheat/security software blocks
  global hooks; start errors are reported by the driver.
- The hook is a process singleton. Multiple keyboard slots share one hook and
  one listener set; the last disconnect stops it.
