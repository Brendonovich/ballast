import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  MidiBackend,
  MidiBackendError,
  type MidiBackendService,
  type MidiPorts,
} from "./backend.ts";

type MidiModule = typeof import("@julusian/midi/lazy");

interface NativePort {
  getPortCount(): number;
  getPortName(port: number): string;
  openPort(port: number): void;
  closePort(): void;
  destroy(): void;
}

const reason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Suffix duplicate system port names so they remain addressable by name. */
export const uniqueNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} #${count}`;
  });
};

const portNames = (port: NativePort): ReadonlyArray<string> =>
  uniqueNames(
    Array.from({ length: port.getPortCount() }, (_, index) => port.getPortName(index)),
  );

const openPort = <Port extends NativePort>(port: Port, id: string, kind: string): Port => {
  const index = portNames(port).indexOf(id);
  if (index < 0) throw new MidiBackendError({ message: `MIDI ${kind} not connected: ${id}` });
  port.openPort(index);
  return port;
};

const release = (port: NativePort): void => {
  try {
    port.closePort();
  } catch {
    // The device may already be gone.
  }
  try {
    port.destroy();
  } catch {
    // RtMidi may have destroyed the port when the device disconnected.
  }
};

const unavailable = (cause: unknown): MidiBackendError =>
  new MidiBackendError({
    message:
      `Native MIDI support is unavailable: ${reason(cause)}. ` +
      `@julusian/midi ships prebuilt N-API binaries for macOS (arm64/x64), Windows (x64/arm64) and Linux (x64/arm64/x64-musl).`,
  });

const makeNativeBackend = (): MidiBackendService => {
  let loaded: MidiModule | undefined;

  const load = async (): Promise<MidiModule> => {
    if (loaded !== undefined) return loaded;
    const module = await import("@julusian/midi/lazy");
    // The /lazy entry never throws on import, so make the failure explicit.
    module.verifyLibraryLoaded();
    loaded = module;
    return module;
  };

  const ports: Effect.Effect<MidiPorts, MidiBackendError> = Effect.tryPromise({
    try: async () => {
      const midi = await load();
      return {
        inputs: uniqueNames(midi.Input.getPortNames()),
        outputs: uniqueNames(midi.Output.getPortNames()),
      };
    },
    catch: unavailable,
  });

  return {
    platform: process.platform,
    ports,
    openInput: (name, onMessage) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const midi = await load();
            const input = new midi.Input();
            try {
              // Receive SysEx; drop clock and active-sensing traffic.
              input.ignoreTypes(false, true, true);
              input.on("message", (_deltaTime, message) => onMessage([...message]));
              return openPort(input, name, "input");
            } catch (cause) {
              release(input);
              throw cause;
            }
          },
          catch: unavailable,
        }),
        (input) =>
          Effect.sync(() => {
            input.removeAllListeners();
            release(input);
          }),
      ).pipe(Effect.asVoid),
    openOutput: (name) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const midi = await load();
            const output = new midi.Output();
            try {
              return openPort(output, name, "output");
            } catch (cause) {
              release(output);
              throw cause;
            }
          },
          catch: unavailable,
        }),
        (output) => Effect.sync(() => release(output)),
      ).pipe(
        Effect.map((output) => ({
          send: (data: ReadonlyArray<number>) =>
            Effect.try({
              try: () => output.sendMessage([...data]),
              catch: (cause) =>
                new MidiBackendError({
                  message: `Failed to send to MIDI output "${name}": ${reason(cause)}`,
                }),
            }),
        })),
      ),
  };
};

/**
 * Live backend. `@julusian/midi/lazy` is imported inside each operation, so a
 * missing binary appears as a connection or option-list error instead of
 * preventing the service from starting.
 */
export const MidiBackendLive: Layer.Layer<MidiBackend> = Layer.sync(
  MidiBackend,
  makeNativeBackend,
);

export { makeNativeBackend };
