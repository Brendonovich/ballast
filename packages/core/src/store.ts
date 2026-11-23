import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { StoreKind, StoreManifest } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { Runtime } from "./runtime.ts";
import { captureSource } from "./source.ts";
import type { DeclarationSource } from "./source.ts";
import { ManifestRecorder } from "./services.ts";
import type { RuntimeRpcClient } from "./runtime-rpc.ts";

export interface StoreLoadSpec {
  readonly name: string;
  readonly kind: StoreKind;
  readonly initial?: number;
}

/**
 * Counter persistence boundary. The worker gets an implementation over the
 * runtime RPC channel; `ballast run` gets an in-memory implementation.
 */
export interface StoreHostService {
  readonly load: (spec: StoreLoadSpec) => Effect.Effect<unknown>;
  readonly setCounter: (name: string, value: number) => Effect.Effect<number>;
  readonly increment: (name: string, by: number, initial: number) => Effect.Effect<number>;
}

export class StoreHost extends Context.Service<StoreHost, StoreHostService>()(
  "Ballast/StoreHost",
) {}

const requireRuntime = Effect.service(Runtime).pipe(Effect.asVoid);

const getStoreHost: Effect.Effect<StoreHostService> = Effect.serviceOption(StoreHost).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        Effect.die(
          new Error("Ballast.Store was used without a StoreHost service"),
        ),
      onSome: (host) => Effect.succeed(host),
    }),
  ),
);

const decodeCounter = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
};

export interface Counter {
  readonly name: string;
  readonly get: Effect.Effect<number, never, Runtime>;
  readonly increment: (by?: number) => Effect.Effect<number, never, Runtime>;
  readonly reset: Effect.Effect<number, never, Runtime>;
}

const counterManifest = (
  name: string,
  initial: number,
  source: DeclarationSource | undefined,
): StoreManifest => ({
  name,
  kind: "counter",
  initial,
  ...(source === undefined ? {} : { source }),
});

const planCounter = (name: string): Counter => ({
  name,
  get: Effect.flatMap(requireRuntime, () =>
    Effect.die(new Error("counter.get was read during init")),
  ),
  increment: () =>
    Effect.flatMap(requireRuntime, () =>
      Effect.die(new Error("counter.increment was read during init")),
    ),
  reset: Effect.flatMap(requireRuntime, () =>
    Effect.die(new Error("counter.reset was read during init")),
  ),
});

const runtimeCounter = (
  name: string,
  initial: number,
  load: StoreLoadSpec,
): Counter => {
  const get: Effect.Effect<number, never, Runtime> = Effect.gen(function* () {
    yield* Runtime;
    const host = yield* getStoreHost;
    return decodeCounter(yield* host.load(load), initial);
  });
  const increment = (by = 1): Effect.Effect<number, never, Runtime> =>
    Effect.gen(function* () {
      yield* Runtime;
      const host = yield* getStoreHost;
      return yield* host.increment(name, by, initial);
    });
  const reset: Effect.Effect<number, never, Runtime> = Effect.gen(function* () {
    yield* Runtime;
    const host = yield* getStoreHost;
    return yield* host.setCounter(name, initial);
  });
  return { name, get, increment, reset };
};

const recordStore = (manifest: StoreManifest): Effect.Effect<void> =>
  Effect.serviceOption(ManifestRecorder).pipe(
    Effect.flatMap((recorder) =>
      recorder._tag === "Some" ? recorder.value.store(manifest) : Effect.void,
    ),
  );

/**
 * Declare a durable counter. Declaration is init-safe; reading or incrementing
 * it requires `Ballast.Runtime`.
 */
export const counter = (
  name: string,
  options: CounterOptions = {},
): Effect.Effect<Counter> => {
  const source = captureSource(2);
  const initial = options.initial ?? 0;
  const manifest = counterManifest(name, initial, source);
  const load: StoreLoadSpec = { name, kind: "counter", initial };
  return Effect.gen(function* () {
    const phase = yield* currentPhase;
    yield* recordStore(manifest);
    return phase === "plan" ? planCounter(name) : runtimeCounter(name, initial, load);
  });
};

export interface CounterOptions {
  readonly initial?: number;
}

interface MemoryStore {
  readonly counter?: number;
}

/** In-memory host for tests and `ballast run`. */
export const StoreHostMemory: Layer.Layer<StoreHost> = Layer.effect(
  StoreHost,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<string, MemoryStore>>(new Map());
    return StoreHost.of({
      load: (spec) =>
        Ref.get(state).pipe(
          Effect.map((stores) => stores.get(spec.name)?.counter ?? spec.initial ?? 0),
        ),
      setCounter: (name, value) =>
        Ref.updateAndGet(state, (stores) => {
          const next = new Map(stores);
          next.set(name, { counter: value });
          return next;
        }).pipe(Effect.map(() => value)),
      increment: (name, by, initial) =>
        Ref.updateAndGet(state, (stores) => {
          const next = new Map(stores);
          const current = next.get(name)?.counter ?? initial;
          next.set(name, { counter: current + by });
          return next;
        }).pipe(Effect.map((stores) => stores.get(name)?.counter ?? initial)),
    });
  }),
);

/** Worker-side StoreHost backed by the runtime RPC client. */
export const makeStoreHostRuntime = (client: RuntimeRpcClient): StoreHostService => ({
  load: (spec) =>
    client
      .StoreLoad({
        name: spec.name,
        kind: spec.kind,
        ...(spec.initial === undefined ? {} : { initial: spec.initial }),
      })
      .pipe(Effect.orDie),
  setCounter: (name, value) =>
    client.StoreSetCounter({ name, value }).pipe(Effect.orDie),
  increment: (name, by, initial) =>
    client.StoreIncrement({ name, by, initial }).pipe(Effect.orDie),
});
