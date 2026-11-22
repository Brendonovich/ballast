import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  KeyboardBackend,
  KeyboardBackendError,
  type KeyboardBackendService,
  type NativeKeyEvent,
} from "./backend.ts";

type UiohookModule = typeof import("uiohook-napi");
type UiohookKeyboardEvent = import("uiohook-napi").UiohookKeyboardEvent;

interface SharedHook {
  readonly module: UiohookModule;
  readonly listeners: Set<(event: NativeKeyEvent) => void>;
  readonly onDown: (event: UiohookKeyboardEvent) => void;
  readonly onUp: (event: UiohookKeyboardEvent) => void;
}

const reason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const permissionHint = (): string =>
  process.platform === "darwin"
    ? " On macOS, grant the Ballast service Accessibility (and Input Monitoring) in System Settings > Privacy & Security, then reconnect."
    : "";

const unavailable = (cause: unknown): KeyboardBackendError =>
  new KeyboardBackendError({
    message:
      `Global keyboard support is unavailable: ${reason(cause)}. ` +
      `uiohook-napi ships prebuilt N-API binaries for macOS (arm64/x64), Windows (x64/arm64) and Linux (X11).` +
      permissionHint(),
  });

// libuiohook is a process-wide singleton. Every backend instance (one per
// keyboard connection slot) shares the same hook and listener set.
let shared: SharedHook | undefined;
const lock = Semaphore.makeUnsafe(1);

const makeNativeBackend = (): KeyboardBackendService => {

  const ensure = Effect.suspend(() => {
    if (shared !== undefined) return Effect.succeed(shared.module);

    return Effect.tryPromise({
      try: async () => {
        const module = await import("uiohook-napi");
        const listeners = new Set<(event: NativeKeyEvent) => void>();
        const dispatch = (
          type: "keydown" | "keyup",
          event: UiohookKeyboardEvent,
        ): void => {
          const payload: NativeKeyEvent = {
            type,
            keycode: event.keycode,
            time: event.time,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          };
          for (const listener of listeners) listener(payload);
        };
        const onDown = (event: UiohookKeyboardEvent) => dispatch("keydown", event);
        const onUp = (event: UiohookKeyboardEvent) => dispatch("keyup", event);

        module.uIOhook.on("keydown", onDown);
        module.uIOhook.on("keyup", onUp);
        try {
          module.uIOhook.start();
        } catch (cause) {
          module.uIOhook.off("keydown", onDown);
          module.uIOhook.off("keyup", onUp);
          throw cause;
        }

        shared = { module, listeners, onDown, onUp };
        return module;
      },
      catch: unavailable,
    });
  }).pipe(lock.withPermit);

  const stop = (hook: SharedHook): void => {
    try {
      hook.module.uIOhook.stop();
    } catch {
      // The hook may already be stopped; the listeners still need removing.
    }
    try {
      hook.module.uIOhook.off("keydown", hook.onDown);
      hook.module.uIOhook.off("keyup", hook.onUp);
    } catch {
      // Removing listeners from a stopped EventEmitter is harmless.
    }
  };

  return {
    platform: process.platform,
    permission: Effect.succeed(process.platform === "darwin" ? "unknown" : "granted"),
    listen: (onEvent) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const module = yield* ensure;
          const hook = shared;
          if (hook === undefined || hook.module !== module) {
            return yield* new KeyboardBackendError({
              message: "The global keyboard hook stopped while it was starting",
            });
          }
          hook.listeners.add(onEvent);
          return hook;
        }),
        (hook) =>
          Effect.sync(() => {
            hook.listeners.delete(onEvent);
            if (hook.listeners.size === 0 && shared === hook) {
              shared = undefined;
              stop(hook);
            }
          }),
      ).pipe(Effect.asVoid),
    keyTap: (keycode, modifierCodes) =>
      Effect.gen(function* () {
        const hook = shared;
        if (hook === undefined) {
          return yield* new KeyboardBackendError({
            message: "The global keyboard hook is not running; connect the keyboard first",
          });
        }
        yield* Effect.try({
          try: () => hook.module.uIOhook.keyTap(keycode, [...modifierCodes]),
          catch: unavailable,
        });
      }),
    keyToggle: (keycode, state) =>
      Effect.gen(function* () {
        const hook = shared;
        if (hook === undefined) {
          return yield* new KeyboardBackendError({
            message: "The global keyboard hook is not running; connect the keyboard first",
          });
        }
        yield* Effect.try({
          try: () => hook.module.uIOhook.keyToggle(keycode, state),
          catch: unavailable,
        });
      }),
  };
};

/**
 * Live backend. The native addon is imported inside `listen`, so a missing
 * binary or an unsupported host produces a connection error instead of
 * preventing the service from starting.
 */
export const KeyboardBackendLive: Layer.Layer<KeyboardBackend> = Layer.sync(
  KeyboardBackend,
  makeNativeBackend,
);

export { makeNativeBackend };
