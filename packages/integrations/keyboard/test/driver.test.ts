import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Keyboard from "../src/index.ts";
import {
  Driver,
  KeyboardBackend,
  KeyboardBackendError,
  layerWith,
} from "../src/driver/index.ts";
import type {
  KeyboardBackendService,
  NativeKeyEvent,
  PermissionStatus,
} from "../src/driver/index.ts";
import type { KeyName } from "../src/index.ts";

const codeOf = (key: KeyName): number => {
  const code = Keyboard.uiohookKeyCode(key);
  if (code === undefined) throw new Error(`No uiohook code for ${key}`);
  return code;
};

const native = (key: KeyName, type: "keydown" | "keyup"): NativeKeyEvent => ({
  type,
  keycode: codeOf(key),
  time: Date.now(),
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
});

interface FakeBackend {
  readonly layer: Layer.Layer<KeyboardBackend>;
  readonly emit: (event: NativeKeyEvent) => void;
  readonly taps: Array<{ readonly keycode: number; readonly modifiers: ReadonlyArray<number> }>;
  readonly listening: () => boolean;
}

const makeFake = (permission: PermissionStatus = "granted"): FakeBackend => {
  const listeners = new Set<(event: NativeKeyEvent) => void>();
  const taps: Array<{ readonly keycode: number; readonly modifiers: ReadonlyArray<number> }> = [];

  const service: KeyboardBackendService = {
    platform: "test",
    permission: Effect.succeed(permission),
    listen: (onEvent) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(onEvent);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(onEvent);
          }),
      ),
    keyTap: (keycode, modifiers) =>
      Effect.sync(() => {
        taps.push({ keycode, modifiers: [...modifiers] });
      }),
    keyToggle: () => Effect.void,
  };

  return {
    layer: Layer.succeed(KeyboardBackend, service),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    taps,
    listening: () => listeners.size > 0,
  };
};

const collect = <A>(stream: Stream.Stream<A>, count: number) =>
  stream.pipe(Stream.take(count), Stream.runCollect, Effect.map((chunk) => Array.from(chunk)));

describe("keyboard driver", () => {
  it.live("maps key edges and hotkeys to bus keys", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const events = yield* collect(driver.events, 4).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");

      yield* driver.connect({
        slot: "main",
        topics: [
          { topic: "keyboard/KeyDown" },
          { topic: "keyboard/Hotkey", condition: { keys: "Ctrl+Shift+F1", state: "down" } },
        ],
      });

      fake.emit(native("Ctrl", "keydown"));
      fake.emit(native("Shift", "keydown"));
      fake.emit(native("F1", "keydown"));

      const result = yield* Fiber.join(events);
      expect(result.map((event) => event.key)).toEqual([
        "keyboard/main/keyboard/KeyDown",
        "keyboard/main/keyboard/KeyDown",
        "keyboard/main/keyboard/KeyDown",
        "keyboard/main/keyboard/Hotkey#Ctrl+Shift+F1/down",
      ]);
      expect(result.map((event) => event.topic)).toEqual([
        "keyboard/KeyDown",
        "keyboard/KeyDown",
        "keyboard/KeyDown",
        "keyboard/Hotkey",
      ]);
      expect(result[2]?.payload).toMatchObject({
        key: "F1",
        ctrl: true,
        shift: true,
        alt: false,
        meta: false,
      });
      expect(result[3]?.payload).toMatchObject({
        key: "F1",
        combo: "Ctrl+Shift+F1",
        state: "down",
        ctrl: true,
        shift: true,
      });
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("drops key repeat and reports press-time modifiers on release", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const events = yield* collect(driver.events, 4).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      yield* driver.connect({
        slot: "main",
        topics: [{ topic: "keyboard/KeyDown" }, { topic: "keyboard/KeyUp" }],
      });

      fake.emit(native("Ctrl", "keydown"));
      fake.emit(native("F1", "keydown"));
      fake.emit(native("F1", "keydown"));
      fake.emit(native("Ctrl", "keyup"));
      fake.emit(native("F1", "keyup"));

      const result = yield* Fiber.join(events);
      expect(result.map((event) => event.topic)).toEqual([
        "keyboard/KeyDown",
        "keyboard/KeyDown",
        "keyboard/KeyUp",
        "keyboard/KeyUp",
      ]);
      expect(result[1]?.payload).toMatchObject({ key: "F1", ctrl: true });
      expect(result[2]?.payload).toMatchObject({ key: "Ctrl", ctrl: false });
      expect(result[3]?.payload).toMatchObject({ key: "F1", ctrl: true });
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("matches hotkeys exactly and can fire on the up edge", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      const events = yield* collect(driver.events, 2).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      yield* driver.connect({
        slot: "main",
        topics: [
          { topic: "keyboard/Hotkey", condition: { keys: "Ctrl+F1", state: "down" } },
          { topic: "keyboard/Hotkey", condition: { keys: "Ctrl+F1", state: "up" } },
        ],
      });

      fake.emit(native("Ctrl", "keydown"));
      fake.emit(native("Shift", "keydown"));
      // Ctrl+Shift+F1 does not match the exact Ctrl+F1 combo.
      fake.emit(native("F1", "keydown"));
      fake.emit(native("Shift", "keyup"));
      fake.emit(native("F1", "keyup"));
      // Now Ctrl is still held, so this is Ctrl+F1.
      fake.emit(native("F1", "keydown"));
      fake.emit(native("F1", "keyup"));

      const result = yield* Fiber.join(events);
      expect(result.map((event) => event.key)).toEqual([
        "keyboard/main/keyboard/Hotkey#Ctrl+F1/down",
        "keyboard/main/keyboard/Hotkey#Ctrl+F1/up",
      ]);
      expect(result[0]?.payload).toMatchObject({ combo: "Ctrl+F1", state: "down" });
      expect(result[1]?.payload).toMatchObject({ combo: "Ctrl+F1", state: "up" });
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("taps a key with its modifiers as libuiohook keycodes", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.connect({ slot: "main", topics: [] });

      const tapped = yield* driver.request("keyboard/tap", {
        key: "F1",
        modifiers: ["Ctrl", "Shift"],
      });
      expect(tapped).toEqual({ ok: true });
      expect(fake.taps).toEqual([
        { keycode: codeOf("F1"), modifiers: [codeOf("Ctrl"), codeOf("Shift")] },
      ]);
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("stops listening on disconnect and rejects requests afterwards", () => {
    const fake = makeFake();
    return Effect.gen(function* () {
      const driver = yield* Driver;
      yield* driver.connect({ slot: "main", topics: [] });

      yield* driver.disconnect;
      expect(fake.listening()).toBe(false);
      const error = yield* driver.request("keyboard/tap", { key: "F1" }).pipe(Effect.flip);
      expect(error.message).toContain("not connected");
    }).pipe(Effect.provide(layerWith(fake.layer)));
  });

  it.live("reports a backend failure as a connection error", () => {
    const service: KeyboardBackendService = {
      platform: "darwin",
      permission: Effect.succeed("denied"),
      listen: () => Effect.fail(new KeyboardBackendError({ message: "uiohook is unavailable" })),
      keyTap: () => Effect.fail(new KeyboardBackendError({ message: "not listening" })),
      keyToggle: () => Effect.fail(new KeyboardBackendError({ message: "not listening" })),
    };

    return Effect.gen(function* () {
      const driver = yield* Driver;
      const error = yield* driver
        .connect({ slot: "main", topics: [], permission: "denied" })
        .pipe(Effect.flip);
      expect(error.message).toContain("uiohook is unavailable");

      const status = yield* driver.status;
      expect(status.state).toBe("error");
    }).pipe(Effect.provide(layerWith(Layer.succeed(KeyboardBackend, service))));
  });
});
