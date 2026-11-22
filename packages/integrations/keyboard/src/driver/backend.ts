import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** macOS needs explicit permission that plain Node cannot query reliably. */
export type PermissionStatus = "granted" | "denied" | "unknown";

/** One key event as delivered by libuiohook. */
export interface NativeKeyEvent {
  readonly type: "keydown" | "keyup";
  readonly keycode: number;
  /** libuiohook's own timestamp (milliseconds). */
  readonly time: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * The small native surface the driver needs. Tests inject a fake
 * implementation; `native.ts` owns the lazy `uiohook-napi` import and the
 * process-wide hook.
 */
export interface KeyboardBackendService {
  readonly platform: string;
  /** Current macOS Accessibility / Input Monitoring state, when known. */
  readonly permission: Effect.Effect<PermissionStatus>;
  /** Acquire the global hook and call `onEvent` for every key edge. */
  readonly listen: (
    onEvent: (event: NativeKeyEvent) => void,
  ) => Effect.Effect<void, KeyboardBackendError, Scope.Scope>;
  /** Synthesize a tap: press and release `keycode` while holding `modifiers`. */
  readonly keyTap: (
    keycode: number,
    modifiers: ReadonlyArray<number>,
  ) => Effect.Effect<void, KeyboardBackendError>;
  /** Press or release a key without a matching release. */
  readonly keyToggle: (
    keycode: number,
    state: "down" | "up",
  ) => Effect.Effect<void, KeyboardBackendError>;
}

export class KeyboardBackendError extends Data.TaggedError("KeyboardBackendError")<{
  readonly message: string;
}> {}

export class KeyboardBackend extends Context.Service<
  KeyboardBackend,
  KeyboardBackendService
>()("ballast/module-keyboard/KeyboardBackend") {}
