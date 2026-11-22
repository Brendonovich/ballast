import type { TopicCondition } from "@ballast/core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { INTEGRATION } from "../constants.ts";
import {
  hotkeyTopicKey,
  keyOptions,
  parseHotkeyCondition,
  type HotkeyFilter,
} from "../hotkey.ts";
import {
  flagsForKeys,
  isModifier,
  keyFromUiohookCode,
  parseKey,
  sameModifiers,
  uiohookKeyCode,
} from "../keys.ts";
import type { KeyName, ModifierFlags } from "../keys.ts";
import { TapInputSchema, ToggleInputSchema } from "../schema.ts";
import type { HotkeyPayload, KeyEventPayload } from "../schema.ts";
import {
  KeyboardBackend,
  type NativeKeyEvent,
  type PermissionStatus,
} from "./backend.ts";
import { KeyboardBackendLive } from "./native.ts";

export class DriverError extends Data.TaggedError("KeyboardDriverError")<{
  readonly message: string;
}> {}

/** A topic subscription from a script manifest. */
export interface DriverTopic {
  readonly topic: string;
  readonly condition?: TopicCondition;
}

export interface DriverConfig {
  readonly slot: string;
  /** Topics from the running scripts' manifests, with their conditions. */
  readonly topics: ReadonlyArray<DriverTopic>;
  /**
   * A permission state supplied by the shell. Electron can answer this with
   * `systemPreferences.isTrustedAccessibilityClient(false)`; plain Node
   * cannot, so the native backend reports `"unknown"` on macOS.
   */
  readonly permission?: PermissionStatus;
}

export type DriverEventPayload = KeyEventPayload | HotkeyPayload;

export interface DriverEvent {
  readonly integration: typeof INTEGRATION;
  readonly slot: string;
  /** Topic name, for example `keyboard/KeyDown` or `keyboard/Hotkey`. */
  readonly topic: string;
  /** Agent bus key. Hotkeys include their combo and state. */
  readonly key: string;
  readonly payload: DriverEventPayload;
  /** Milliseconds since the Unix epoch. */
  readonly at: number;
}

export type DriverStatus =
  | { readonly state: "disconnected"; readonly platform: string }
  | { readonly state: "connecting"; readonly platform: string }
  | {
      readonly state: "listening";
      readonly platform: string;
      readonly permission: PermissionStatus;
      readonly startedAt: number;
      readonly topics: ReadonlyArray<string>;
      readonly hint?: string;
    }
  | {
      readonly state: "error";
      readonly platform: string;
      readonly permission: PermissionStatus;
      readonly message: string;
      readonly hint?: string;
    };

export interface DriverService {
  readonly connect: (config: DriverConfig) => Effect.Effect<void, DriverError>;
  readonly disconnect: Effect.Effect<void>;
  /** One event per matching topic, keyed for the agent's event bus. */
  readonly events: Stream.Stream<DriverEvent>;
  readonly status: Effect.Effect<DriverStatus>;
  readonly request: (request: string, input: unknown) => Effect.Effect<unknown, DriverError>;
  readonly options: (source: string) => Effect.Effect<ReadonlyArray<string>, DriverError>;
}

export class Driver extends Context.Service<Driver, DriverService>()(
  "ballast/module-keyboard/Driver",
) {}

const KEY_DOWN_TOPIC = `${INTEGRATION}/KeyDown`;
const KEY_UP_TOPIC = `${INTEGRATION}/KeyUp`;
const HOTKEY_TOPIC = `${INTEGRATION}/Hotkey`;

const topicKey = (slot: string, topic: string): string =>
  `${INTEGRATION}/${slot}/${topic}`;

const permissionHint = (permission: PermissionStatus, platform: string): string | undefined =>
  platform === "darwin" && permission !== "granted"
    ? "macOS requires Accessibility (and usually Input Monitoring) permission for the process running the Ballast service. Grant it in System Settings > Privacy & Security, then reconnect."
    : undefined;

interface Subscriptions {
  readonly keyDown: boolean;
  readonly keyUp: boolean;
  readonly hotkeys: ReadonlyArray<HotkeyFilter>;
}

const parseSubscriptions = (
  topics: ReadonlyArray<DriverTopic>,
): Effect.Effect<Subscriptions, DriverError> =>
  Effect.gen(function* () {
    let keyDown = false;
    let keyUp = false;
    const hotkeys: Array<HotkeyFilter> = [];
    const seen = new Set<string>();

    for (const entry of topics) {
      if (entry.topic === KEY_DOWN_TOPIC) {
        keyDown = true;
        continue;
      }
      if (entry.topic === KEY_UP_TOPIC) {
        keyUp = true;
        continue;
      }
      if (entry.topic === HOTKEY_TOPIC) {
        const parsed = parseHotkeyCondition(entry.condition);
        if (!parsed.ok) return yield* new DriverError({ message: parsed.message });
        const dedupeKey = `${parsed.filter.combo}/${parsed.filter.state}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          hotkeys.push(parsed.filter);
        }
        continue;
      }
      return yield* new DriverError({
        message: `Unknown keyboard topic "${entry.topic}"`,
      });
    }

    return { keyDown, keyUp, hotkeys };
  });

const flagsFromHeld = (held: ReadonlyMap<KeyName, ModifierFlags>, key: KeyName): ModifierFlags => ({
  ctrl: key !== "Ctrl" && held.has("Ctrl"),
  shift: key !== "Shift" && held.has("Shift"),
  alt: key !== "Alt" && held.has("Alt"),
  meta: key !== "Meta" && held.has("Meta"),
});

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  input: unknown,
): Effect.Effect<A, DriverError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new DriverError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const make = Effect.gen(function* () {
  const backend = yield* KeyboardBackend;
  const pubsub = yield* PubSub.unbounded<DriverEvent>();
  const statusRef = yield* Ref.make<DriverStatus>({
    state: "disconnected",
    platform: backend.platform,
  });
  const sessionRef = yield* Ref.make<Scope.Closeable | undefined>(undefined);
  const lock = yield* Semaphore.make(1);
  const held = new Map<KeyName, ModifierFlags>();

  let slot = "";
  let subscriptions: Subscriptions = { keyDown: false, keyUp: false, hotkeys: [] };

  const publish = (topic: string, key: string, payload: DriverEventPayload): void => {
    const event: DriverEvent = {
      integration: INTEGRATION,
      slot,
      topic,
      key,
      payload,
      at: Date.now(),
    };
    PubSub.publishUnsafe(pubsub, event);
  };

  const onEvent = (event: NativeKeyEvent): void => {
    const key = keyFromUiohookCode(event.keycode);
    if (key === undefined) return;

    if (event.type === "keydown") {
      // libuiohook repeats a key while it is held; a key down must fire once.
      if (held.has(key)) return;
      const flags = flagsFromHeld(held, key);
      held.set(key, flags);
      const at = Date.now();
      const payload: KeyEventPayload = {
        key,
        code: event.keycode,
        ...flags,
        at,
      };
      if (subscriptions.keyDown) publish(KEY_DOWN_TOPIC, topicKey(slot, KEY_DOWN_TOPIC), payload);

      for (const filter of subscriptions.hotkeys) {
        if (filter.state !== "down" || filter.key !== key) continue;
        if (!sameModifiers(flags, flagsForKeys(filter.modifiers))) continue;
        const hotkey: HotkeyPayload = {
          key,
          code: event.keycode,
          combo: filter.combo,
          state: "down",
          ...flags,
          at,
        };
        publish(HOTKEY_TOPIC, hotkeyTopicKey(slot, filter), hotkey);
      }
      return;
    }

    const flags = held.get(key);
    if (flags === undefined) return;
    held.delete(key);
    const at = Date.now();
    const payload: KeyEventPayload = {
      key,
      code: event.keycode,
      ...flags,
      at,
    };
    if (subscriptions.keyUp) publish(KEY_UP_TOPIC, topicKey(slot, KEY_UP_TOPIC), payload);

    for (const filter of subscriptions.hotkeys) {
      if (filter.state !== "up" || filter.key !== key) continue;
      if (!sameModifiers(flags, flagsForKeys(filter.modifiers))) continue;
      const hotkey: HotkeyPayload = {
        key,
        code: event.keycode,
        combo: filter.combo,
        state: "up",
        ...flags,
        at,
      };
      publish(HOTKEY_TOPIC, hotkeyTopicKey(slot, filter), hotkey);
    }
  };

  const disconnectUnlocked = Effect.gen(function* () {
    const session = yield* Ref.get(sessionRef);
    yield* Ref.set(sessionRef, undefined);
    held.clear();
    if (session !== undefined) yield* Scope.close(session, Exit.void);
    yield* Ref.set(statusRef, { state: "disconnected", platform: backend.platform });
  });

  const disconnect = lock.withPermit(disconnectUnlocked);

  const connect = (config: DriverConfig): Effect.Effect<void, DriverError> =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* disconnectUnlocked;
        yield* Ref.set(statusRef, { state: "connecting", platform: backend.platform });

        const permission = config.permission ?? (yield* backend.permission);
        const hint = permissionHint(permission, backend.platform);
        const parsed = yield* parseSubscriptions(config.topics).pipe(
          Effect.tapError((error) =>
            Ref.set(statusRef, {
              state: "error",
              platform: backend.platform,
              permission,
              message: error.message,
              ...(hint === undefined ? {} : { hint }),
            }),
          ),
        );

        const scope = yield* Scope.make();
        slot = config.slot;
        subscriptions = parsed;
        held.clear();

        yield* backend.listen(onEvent).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void);
              yield* Ref.set(statusRef, {
                state: "error",
                platform: backend.platform,
                permission,
                message: error.message,
                ...(hint === undefined ? {} : { hint }),
              });
            }),
          ),
          Effect.mapError((error) => new DriverError({ message: error.message })),
        );

        yield* Ref.set(sessionRef, scope);
        yield* Ref.set(statusRef, {
          state: "listening",
          platform: backend.platform,
          permission,
          startedAt: Date.now(),
          topics: config.topics.map((entry) => entry.topic),
          ...(hint === undefined ? {} : { hint }),
        });
      }),
    );

  const request = (
    name: string,
    input: unknown,
  ): Effect.Effect<unknown, DriverError> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(statusRef);
      if (current.state !== "listening") {
        return yield* new DriverError({
          message: `Keyboard "${slot}" is not connected`,
        });
      }

      if (name === "keyboard/tap") {
        const parsed = yield* decode(TapInputSchema, input);
        const keycode = uiohookKeyCode(parsed.key);
        if (keycode === undefined) {
          return yield* new DriverError({
            message: `Key "${parsed.key}" cannot be simulated on this platform`,
          });
        }
        const modifierCodes: Array<number> = [];
        for (const modifier of parsed.modifiers ?? []) {
          const resolved = parseKey(modifier);
          if (resolved === undefined || !isModifier(resolved)) {
            return yield* new DriverError({
              message: `"${modifier}" is not a modifier key`,
            });
          }
          const code = uiohookKeyCode(resolved);
          if (code !== undefined) modifierCodes.push(code);
        }
        yield* backend
          .keyTap(keycode, modifierCodes)
          .pipe(Effect.mapError((error) => new DriverError({ message: error.message })));
        return { ok: true };
      }

      if (name === "keyboard/toggle") {
        const parsed = yield* decode(ToggleInputSchema, input);
        const keycode = uiohookKeyCode(parsed.key);
        if (keycode === undefined) {
          return yield* new DriverError({
            message: `Key "${parsed.key}" cannot be simulated on this platform`,
          });
        }
        yield* backend
          .keyToggle(keycode, parsed.state)
          .pipe(Effect.mapError((error) => new DriverError({ message: error.message })));
        return { ok: true };
      }

      return yield* new DriverError({ message: `Unknown keyboard request "${name}"` });
    });

  const options = (source: string): Effect.Effect<ReadonlyArray<string>, DriverError> =>
    source === "keys"
      ? Effect.succeed(keyOptions)
      : Effect.fail(new DriverError({ message: `Unknown keyboard option source "${source}"` }));

  yield* Effect.addFinalizer(() => disconnectUnlocked);

  return Driver.of({
    connect,
    disconnect,
    events: Stream.fromPubSub(pubsub),
    status: Ref.get(statusRef),
    request,
    options,
  });
});

const driverLayer = Layer.effect(Driver, make);

/** Driver wired to the real libuiohook backend. */
export const layer: Layer.Layer<Driver> = driverLayer.pipe(
  Layer.provide(KeyboardBackendLive),
);

/** Driver with an injected backend, for tests and alternative hosts. */
export const layerWith = (
  backend: Layer.Layer<KeyboardBackend>,
): Layer.Layer<Driver> => driverLayer.pipe(Layer.provide(backend));
