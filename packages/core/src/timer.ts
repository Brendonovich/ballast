import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OnStale, TimerManifest } from "./manifest.ts";
import type { DeclarationSource } from "./source.ts";
import { provideRuntime, Runtime } from "./runtime.ts";
import { captureSource } from "./source.ts";
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
  /** Raw declaration location; the planner maps it to project source. */
  readonly source?: DeclarationSource;
}

export interface TimerMetadata<A> {
  readonly name: string;
  readonly title: string | undefined;
  readonly onStale: OnStale;
  readonly maxAgeMs: number;
  readonly payloadSchema: unknown;
  readonly payloadFingerprint: string;
  readonly source: DeclarationSource | undefined;
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
   * Schedule (or replace) one timer instance. `key` is the idempotency key
   * within this timer: scheduling the same key replaces the due time and
   * payload instead of creating a second instance.
   */
  readonly after: (
    key: string,
    after: Duration.Input,
    payload: A,
  ) => Effect.Effect<void, never, Runtime>;
  /** Cancel a pending or fired instance. Cancelling a missing key is a no-op. */
  readonly cancel: (key: string) => Effect.Effect<void, never, Runtime>;
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
    source: spec.source,
    codec,
  };
};

export const toTimerManifest = (timer: TimerMetadata<unknown>): TimerManifest => ({
  name: timer.name,
  ...(timer.source === undefined ? {} : { source: timer.source }),
  ...(timer.title === undefined ? {} : { title: timer.title }),
  onStale: timer.onStale,
  maxAgeMs: timer.maxAgeMs,
  payloadSchema: timer.payloadSchema,
  payloadFingerprint: timer.payloadFingerprint,
});

export interface TimerHostService {
  readonly subscribe: <A>(
    spec: TimerSpec<A>,
    handler: (fire: TimerFire<A>) => Effect.Effect<void, unknown, never>,
  ) => Effect.Effect<Timer<A>>;
}

/**
 * The host service timers are declared through. Plan records the declaration
 * and never evaluates the handler; runtime registers the handler with the
 * agent-provided timer runtime. There is no separate define/register step.
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
    handler: (fire: TimerFire<A>) => Effect.Effect<void, unknown, never>,
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
  readonly after: (
    key: string,
    after: Duration.Input,
    payload: A,
  ) => Effect.Effect<void, never, Runtime>;
  readonly cancel: (key: string) => Effect.Effect<void, never, Runtime>;
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
      subscribe: (spec, _handler) =>
        Effect.gen(function* () {
          const metadata = toTimerMetadata(spec);
          const signature = `${metadata.payloadFingerprint}:${metadata.onStale}:${metadata.maxAgeMs}`;
          const previous = declared.get(metadata.name);
          if (previous !== undefined && previous !== signature) {
            return yield* Effect.die(new TimerDeclarationError(metadata.name));
          }
          declared.set(metadata.name, signature);
          yield* subscribeInPlan(recorder, metadata);
          return makeTimer(metadata, {
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
      subscribe: (spec, handler) =>
        Effect.gen(function* () {
          const metadata = toTimerMetadata(spec);
          yield* withTimerRuntime(runtime, metadata.name, (service) =>
            service.subscribe(metadata, handler),
          );
          return makeTimer(metadata, {
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
 * Declare a durable timer, register its handler, and return the handle. This is
 * the only timer declaration form; schedule instances from handlers or
 * `Ballast.run`.
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
  handler: (fire: TimerFire<A>) => Effect.Effect<void, unknown, Runtime>,
  options: Omit<TimerOptions<A>, "payload"> = {},
): Effect.Effect<Timer<A>, never, TimerHost> => {
  const source = captureSource(2);
  return Effect.flatMap(TimerHost, (host) => {
    const spec: TimerSpec<A> = {
      name,
      payload,
      ...options,
      ...(source === undefined ? {} : { source }),
    };
    return host.subscribe(spec, (fire) => provideRuntime(handler(fire)));
  });
};
