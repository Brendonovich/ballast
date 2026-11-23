import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OnStale, TimerManifest } from "./manifest.ts";
import { ManifestRecorder } from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";

/**
 * Timers are the durable sleep primitive. A timer is declared in init, its
 * payload schema is captured into the manifest, and a handler is registered for
 * fires. Scheduling happens in handlers or Ballast.run, never in init.
 *
 * This is deliberately a timer `event`, not a resumable continuation: a
 * durable sleep can only resume code after the sleep by replaying the code that
 * ran before it. Ballast does not run handlers as durable workflows yet, so
 * the continuation after a sleep must be an explicit handler.
 */

/** Default: a timer is a promise to run work, so late fires are delivered. */
export const DEFAULT_TIMER_ON_STALE: OnStale = "deliver";

/** Default late-fire window: one week. */
export const DEFAULT_TIMER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TimerOptions<A> {
  readonly title?: string;
  /**
   * What to do when the host finds this timer due only after the machine was
   * asleep or the service was down for longer than `maxAgeMs`.
   *
   * `"deliver"` fires it once with `lateByMs`; `"drop"` drops it.
   */
  readonly onStale?: OnStale;
  readonly maxAgeMs?: number;
  /** Persisted payload codec. Payloads must encode to JSON. */
  readonly payload: Schema.Codec<A, unknown, never, never>;
}

export interface TimerSpec<A> extends TimerOptions<A> {
  readonly name: string;
}

export interface TimerMetadata<A> {
  readonly name: string;
  readonly title: string | undefined;
  readonly onStale: OnStale;
  readonly maxAgeMs: number;
  readonly payloadSchema: unknown;
  readonly payloadFingerprint: string;
  /** Canonical JSON codec used for persistence and delivery. */
  readonly codec: Schema.Codec<A, Schema.Json, never, never>;
}

export interface TimerFire<A> {
  readonly timer: string;
  readonly key: string;
  readonly payload: A;
  /** Epoch milliseconds when the timer was (re)scheduled. */
  readonly scheduledAt: number;
  /** Epoch milliseconds when it was due. */
  readonly dueAt: number;
  /** Epoch milliseconds when the host woke it. */
  readonly firedAt: number;
  /** `firedAt - dueAt`, never negative. */
  readonly lateByMs: number;
}

export interface Timer<A> {
  readonly name: string;
  readonly title: string | undefined;
  readonly onStale: OnStale;
  readonly maxAgeMs: number;
  readonly payloadFingerprint: string;
  /**
   * Register the handler for this timer. Declares the timer in the manifest in
   * plan phase and registers a runtime handler at runtime. The handler is never
   * evaluated while planning.
   */
  readonly subscribe: (
    handler: (fire: TimerFire<A>) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
  /**
   * Schedule (or replace) one timer instance. `key` is the idempotency key
   * within this timer: scheduling the same key replaces the due time and
   * payload instead of creating a second instance.
   */
  readonly after: (
    key: string,
    after: Duration.Input,
    payload: A,
  ) => Effect.Effect<void>;
  /** Cancel a pending or fired instance. Cancelling a missing key is a no-op. */
  readonly cancel: (key: string) => Effect.Effect<void>;
}

/** A timer whose payload is `void`; `after` takes no payload argument. */
export interface UnitTimer extends Omit<Timer<void>, "after"> {
  readonly after: (key: string, after: Duration.Input) => Effect.Effect<void>;
}

export class TimerCalledDuringPlanError extends Error {
  readonly timer: string;

  constructor(timer: string) {
    super(
      `Timer "${timer}" was scheduled or cancelled during plan. Init must declare timers; handlers and Ballast.run schedule them.`,
    );
    this.name = "TimerCalledDuringPlanError";
    this.timer = timer;
  }
}

export class TimerDeclarationError extends Error {
  readonly timer: string;

  constructor(timer: string) {
    super(
      `Timer "${timer}" was declared twice with different payload schemas or policies. Use one declaration per timer name.`,
    );
    this.name = "TimerDeclarationError";
    this.timer = timer;
  }
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const payloadFingerprint = (schema: unknown): string =>
  createHash("sha256").update(stableJson(schema)).digest("hex");

export const toTimerMetadata = <A>(spec: TimerSpec<A>): TimerMetadata<A> => {
  if (spec.name.trim().length === 0) {
    throw new Error("Timer names must be non-empty");
  }
  const maxAgeMs = spec.maxAgeMs ?? DEFAULT_TIMER_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error(
      `Timer "${spec.name}" maxAgeMs must be a finite, non-negative number`,
    );
  }
  const codec: Schema.Codec<A, Schema.Json, never, never> = Schema.toCodecJson(spec.payload);
  const payloadSchema = Schema.toJsonSchemaDocument(codec);
  return {
    name: spec.name,
    title: spec.title,
    onStale: spec.onStale ?? DEFAULT_TIMER_ON_STALE,
    maxAgeMs,
    payloadSchema,
    payloadFingerprint: payloadFingerprint(payloadSchema),
    codec,
  };
};

export const toTimerManifest = (timer: TimerMetadata<unknown>): TimerManifest => ({
  name: timer.name,
  ...(timer.title === undefined ? {} : { title: timer.title }),
  onStale: timer.onStale,
  maxAgeMs: timer.maxAgeMs,
  payloadSchema: timer.payloadSchema,
  payloadFingerprint: timer.payloadFingerprint,
});

export interface TimerHostService {
  readonly make: <A>(spec: TimerSpec<A>) => Effect.Effect<Timer<A>>;
}

/**
 * The host service timers are declared through. Plan records the declaration
 * and never registers a handler; runtime registers the handler with the
 * agent-provided timer runtime.
 */
export class TimerHost extends Context.Service<TimerHost, TimerHostService>()(
  "Ballast/TimerHost",
) {}

/**
 * The runtime side of timers, provided by the script worker. The worker turns
 * these calls into runtime RPCs; the agent owns persistence and scheduling.
 */
export interface TimerRuntimeService {
  readonly subscribe: <A>(
    timer: TimerMetadata<A>,
    handler: (fire: TimerFire<A>) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
  readonly schedule: <A>(
    timer: TimerMetadata<A>,
    input: {
      readonly key: string;
      readonly duration: Duration.Duration;
      readonly payload: A;
    },
  ) => Effect.Effect<void>;
  readonly cancel: (timer: TimerMetadata<unknown>, key: string) => Effect.Effect<void>;
}

export class TimerRuntime extends Context.Service<TimerRuntime, TimerRuntimeService>()(
  "Ballast/TimerRuntime",
) {}

interface TimerImplementation<A> {
  readonly subscribe: (
    handler: (fire: TimerFire<A>) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
  readonly after: (
    key: string,
    after: Duration.Input,
    payload: A,
  ) => Effect.Effect<void>;
  readonly cancel: (key: string) => Effect.Effect<void>;
}

const makeTimer = <A>(
  metadata: TimerMetadata<A>,
  implementation: TimerImplementation<A>,
): Timer<A> => ({
  name: metadata.name,
  title: metadata.title,
  onStale: metadata.onStale,
  maxAgeMs: metadata.maxAgeMs,
  payloadFingerprint: metadata.payloadFingerprint,
  subscribe: implementation.subscribe,
  after: implementation.after,
  cancel: implementation.cancel,
});

const subscribeInPlan = (
  recorder: Option.Option<ManifestRecorderService>,
  timer: TimerMetadata<unknown>,
): Effect.Effect<void> =>
  Option.match(recorder, {
    onNone: () =>
      Effect.die(
        new Error(
          `Timer "${timer.name}" was declared in plan phase without a ManifestRecorder`,
        ),
      ),
    onSome: (service) => service.timer(toTimerManifest(timer)),
  });

/**
 * Plan-phase host: `subscribe` records the timer declaration into the manifest
 * and never keeps the handler. `after` and `cancel` die because they are I/O.
 */
export const TimerHostPlan: Layer.Layer<TimerHost> = Layer.effect(
  TimerHost,
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(ManifestRecorder);
    const declared = new Map<string, string>();

    return TimerHost.of({
      make: (spec) =>
        Effect.gen(function* () {
          const metadata = toTimerMetadata(spec);
          const signature = `${metadata.payloadFingerprint}:${metadata.onStale}:${metadata.maxAgeMs}`;
          const previous = declared.get(metadata.name);
          if (previous !== undefined && previous !== signature) {
            return yield* Effect.die(new TimerDeclarationError(metadata.name));
          }
          declared.set(metadata.name, signature);
          return makeTimer(metadata, {
            subscribe: (_handler) => subscribeInPlan(recorder, metadata),
            after: () => Effect.die(new TimerCalledDuringPlanError(metadata.name)),
            cancel: () => Effect.die(new TimerCalledDuringPlanError(metadata.name)),
          });
        }),
    });
  }),
);

const withTimerRuntime = <A>(
  runtime: Option.Option<TimerRuntimeService>,
  name: string,
  use: (service: TimerRuntimeService) => Effect.Effect<A>,
): Effect.Effect<A> =>
  Option.match(runtime, {
    onNone: () =>
      Effect.die(
        new Error(
          `Timer "${name}" was used without a TimerRuntime service; the runtime worker must provide one`,
        ),
      ),
    onSome: use,
  });

/** Runtime host: subscriptions and scheduling go through the worker's TimerRuntime. */
export const TimerHostRuntime: Layer.Layer<TimerHost> = Layer.effect(
  TimerHost,
  Effect.gen(function* () {
    const runtime = yield* Effect.serviceOption(TimerRuntime);

    return TimerHost.of({
      make: (spec) =>
        Effect.sync(() => {
          const metadata = toTimerMetadata(spec);
          return makeTimer(metadata, {
            subscribe: (handler) =>
              withTimerRuntime(runtime, metadata.name, (service) =>
                service.subscribe(metadata, handler),
              ),
            after: (key, after, payload) =>
              withTimerRuntime(runtime, metadata.name, (service) =>
                service.schedule(metadata, {
                  key,
                  duration: Duration.fromInputUnsafe(after),
                  payload,
                }),
              ),
            cancel: (key) =>
              withTimerRuntime(runtime, metadata.name, (service) =>
                service.cancel(metadata, key),
              ),
          });
        }),
    });
  }),
);

/**
 * Declare a durable timer. Call this in init and subscribe in the same init;
 * schedule instances from handlers or `Ballast.run`.
 */
export const make = <A>(
  name: string,
  options: TimerOptions<A>,
): Effect.Effect<Timer<A>, never, TimerHost> =>
  Effect.flatMap(TimerHost, (host) => host.make({ name, ...options }));

/**
 * Declare a timer, subscribe its handler, and return the handle in one step.
 * This is the shortest form for init:
 *
 * ```ts
 * const cooldown = yield* Ballast.Timer.subscribe(
 *   "cooldown",
 *   CooldownPayload,
 *   (fire) => Effect.log(fire.payload.user),
 *   { onStale: "deliver" },
 * );
 * ```
 */
export const subscribe = <A>(
  name: string,
  payload: Schema.Codec<A, unknown, never, never>,
  handler: (fire: TimerFire<A>) => Effect.Effect<void, never, never>,
  options: Omit<TimerOptions<A>, "payload"> = {},
): Effect.Effect<Timer<A>, never, TimerHost> =>
  Effect.gen(function* () {
    const timer = yield* make(name, { ...options, payload });
    yield* timer.subscribe(handler);
    return timer;
  });

/** Declare a timer with no payload; `after` takes only a key and a duration. */
export const unit = (
  name: string,
  options: Omit<TimerOptions<void>, "payload"> = {},
): Effect.Effect<UnitTimer, never, TimerHost> =>
  Effect.map(make(name, { ...options, payload: Schema.Void }), (timer) => ({
    name: timer.name,
    title: timer.title,
    onStale: timer.onStale,
    maxAgeMs: timer.maxAgeMs,
    payloadFingerprint: timer.payloadFingerprint,
    subscribe: timer.subscribe,
    cancel: timer.cancel,
    after: (key, after) => timer.after(key, after, undefined),
  }));
