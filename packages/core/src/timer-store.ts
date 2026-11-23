import type { Clock } from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import type { OnStale } from "./manifest.ts";
import { OnStaleSchema } from "./manifest.ts";

export const TimerStateSchema = Schema.Literals(["pending", "fired", "dropped"]);
export type TimerState = Schema.Schema.Type<typeof TimerStateSchema>;

/**
 * One durable timer instance. The key is `(scriptId, timer, key)`; scheduling
 * the same key replaces the entry. `firedAt` is written before the fire is
 * delivered, so a host restart does not replay a fire (at-most-once).
 */
export const ScheduledTimerSchema = Schema.Struct({
  /** Legacy per-script owner; project-mode timers omit it. */
  scriptId: Schema.optional(Schema.String),
  timer: Schema.String,
  key: Schema.String,
  payload: Schema.Json,
  payloadFingerprint: Schema.String,
  scheduledAt: Schema.Number,
  dueAt: Schema.Number,
  onStale: OnStaleSchema,
  maxAgeMs: Schema.Number,
  state: TimerStateSchema,
  firedAt: Schema.optional(Schema.Number),
  lateByMs: Schema.optional(Schema.Number),
});
export type ScheduledTimer = Schema.Schema.Type<typeof ScheduledTimerSchema>;

export const TimerStoreSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  timers: Schema.Array(ScheduledTimerSchema),
});
export type TimerStoreSnapshot = Schema.Schema.Type<typeof TimerStoreSnapshotSchema>;

export const decodeTimerStoreSnapshot = (input: unknown): TimerStoreSnapshot =>
  Schema.decodeUnknownSync(TimerStoreSnapshotSchema)(input);

export interface TimerScheduleInput {
  readonly scriptId?: string;
  readonly timer: string;
  readonly key: string;
  readonly delayMs: number;
  readonly payload: Schema.Json;
  readonly payloadFingerprint: string;
  readonly onStale: OnStale;
  readonly maxAgeMs: number;
}

export interface TimerFireRecord {
  readonly scriptId?: string;
  readonly timer: string;
  readonly key: string;
  readonly payload: Schema.Json;
  readonly scheduledAt: number;
  readonly dueAt: number;
  readonly firedAt: number;
  readonly lateByMs: number;
}

export interface TimerSchedulerService {
  /** Schedule or replace one instance. */
  readonly schedule: (input: TimerScheduleInput) => Effect.Effect<void>;
  /** Cancel one instance; missing keys are ignored. */
  readonly cancel: (scriptId: string, timer: string, key: string) => Effect.Effect<void>;
  /** Pending instances, for a UI or diagnostics. */
  readonly pending: Effect.Effect<ReadonlyArray<ScheduledTimer>>;
  /** Persistable state. */
  readonly snapshot: Effect.Effect<TimerStoreSnapshot>;
  /** Replace the in-memory store (for example after a service restart). */
  readonly restore: (snapshot: TimerStoreSnapshot) => Effect.Effect<void>;
  /**
   * Fire every pending timer whose `dueAt <= now`, applying the late policy.
   * Exposed for tests and for a host that owns its own wake loop.
   */
  readonly fireDue: (now: number) => Effect.Effect<ReadonlyArray<TimerFireRecord>>;
}

export class TimerScheduler extends Context.Service<TimerScheduler, TimerSchedulerService>()(
  "Ballast/TimerScheduler",
) {}

export interface TimerSchedulerOptions {
  /** The host's clock. Tests pass a TestClock; the agent passes its Clock service. */
  readonly clock: Clock;
  readonly onFire: (fire: TimerFireRecord) => Effect.Effect<void>;
  readonly initial?: TimerStoreSnapshot;
}

const instanceKey = (timer: Pick<ScheduledTimer, "scriptId" | "timer" | "key">): string =>
  `${timer.scriptId ?? ""}\u0000${timer.timer}\u0000${timer.key}`;

const compareTimers = (left: ScheduledTimer, right: ScheduledTimer): number =>
  left.dueAt - right.dueAt ||
  (left.scriptId ?? "").localeCompare(right.scriptId ?? "") ||
  left.timer.localeCompare(right.timer) ||
  left.key.localeCompare(right.key);

const toStore = (snapshot: TimerStoreSnapshot | undefined): Map<string, ScheduledTimer> => {
  const store = new Map<string, ScheduledTimer>();
  for (const timer of snapshot?.timers ?? []) {
    store.set(instanceKey(timer), timer);
  }
  return store;
};

const sorted = (timers: Iterable<ScheduledTimer>): ReadonlyArray<ScheduledTimer> =>
  [...timers].sort(compareTimers);

const earliestPending = (timers: Iterable<ScheduledTimer>): number | undefined => {
  let earliest: number | undefined;
  for (const timer of timers) {
    if (timer.state !== "pending") continue;
    if (earliest === undefined || timer.dueAt < earliest) earliest = timer.dueAt;
  }
  return earliest;
};

/**
 * Reference in-memory timer scheduler. It owns the persistence shape and the
 * late-fire policy; the agent replaces the in-memory store with
 * `.ballast/timers.json` (see decision 0006's service integration section).
 *
 * The wake loop coalesces all pending timers into one sleep on the earliest
 * `dueAt`. A schedule or restore wakes it early.
 */
export const makeTimerScheduler = (
  options: TimerSchedulerOptions,
): Effect.Effect<TimerSchedulerService, never, Scope> =>
  Effect.gen(function* () {
    const clock = options.clock;
    const state = yield* Ref.make(toStore(options.initial));
    const signal = yield* Queue.unbounded<void>();

    const notify = Effect.sync(() => {
      Queue.offerUnsafe(signal, undefined);
    });

    const schedule = (input: TimerScheduleInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = clock.currentTimeMillisUnsafe();
        const timer: ScheduledTimer = {
          ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
          timer: input.timer,
          key: input.key,
          payload: input.payload,
          payloadFingerprint: input.payloadFingerprint,
          scheduledAt: now,
          dueAt: now + Math.max(0, input.delayMs),
          onStale: input.onStale,
          maxAgeMs: input.maxAgeMs,
          state: "pending",
        };
        yield* Ref.update(state, (current) => {
          const next = new Map(current);
          next.set(instanceKey(timer), timer);
          return next;
        });
        yield* notify;
      });

    const cancel = (scriptId: string, timer: string, key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => {
          const next = new Map(current);
          next.delete(instanceKey({ scriptId, timer, key }));
          return next;
        });
        yield* notify;
      });

    const pending: Effect.Effect<ReadonlyArray<ScheduledTimer>> = Effect.map(
      Ref.get(state),
      (current) => sorted([...current.values()].filter((timer) => timer.state === "pending")),
    );

    const snapshot: Effect.Effect<TimerStoreSnapshot> = Effect.map(
      Ref.get(state),
      (current) => ({
        version: 1,
        timers: sorted(current.values()),
      }),
    );

    const restore = (value: TimerStoreSnapshot): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(state, toStore(value));
        yield* notify;
      });

    const takeDue = (now: number): Effect.Effect<ReadonlyArray<TimerFireRecord>> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const due = sorted(
          [...current.values()].filter(
            (timer) => timer.state === "pending" && timer.dueAt <= now,
          ),
        );
        if (due.length === 0) return [];

        const next = new Map(current);
        const fires: TimerFireRecord[] = [];

        for (const timer of due) {
          const lateByMs = Math.max(0, now - timer.dueAt);
          if (timer.onStale === "drop" && lateByMs > timer.maxAgeMs) {
            next.set(instanceKey(timer), { ...timer, state: "dropped" });
            continue;
          }

          next.set(instanceKey(timer), {
            ...timer,
            state: "fired",
            firedAt: now,
            lateByMs,
          });
          fires.push({
            ...(timer.scriptId === undefined ? {} : { scriptId: timer.scriptId }),
            timer: timer.timer,
            key: timer.key,
            payload: timer.payload,
            scheduledAt: timer.scheduledAt,
            dueAt: timer.dueAt,
            firedAt: now,
            lateByMs,
          });
        }

        yield* Ref.set(state, next);
        return fires;
      });

    const notifyFire = (fire: TimerFireRecord): Effect.Effect<void> =>
      options.onFire(fire).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Timer fire failed for ${fire.scriptId}/${fire.timer}/${fire.key}`,
            cause,
          ),
        ),
      );

    const fireDue = (now: number): Effect.Effect<ReadonlyArray<TimerFireRecord>> =>
      Effect.gen(function* () {
        const fires = yield* takeDue(now);
        yield* Effect.forEach(fires, notifyFire, { discard: true });
        return fires;
      });

    const loop: Effect.Effect<never> = Effect.gen(function* () {
      while (true) {
        const now = clock.currentTimeMillisUnsafe();
        const fires = yield* takeDue(now);
        if (fires.length > 0) {
          yield* Effect.forEach(fires, notifyFire, { discard: true });
          continue;
        }

        const next = earliestPending((yield* Ref.get(state)).values());
        if (next === undefined) {
          yield* Queue.take(signal);
          continue;
        }

        const wait = next - now;
        if (wait <= 0) continue;
        yield* Effect.raceFirst(
          clock.sleep(Duration.millis(wait)),
          Queue.take(signal),
        );
      }
    });

    yield* Effect.forkScoped(loop);

    return TimerScheduler.of({
      schedule,
      cancel,
      pending,
      snapshot,
      restore,
      fireDue,
    });
  });

export const layer = (
  options: TimerSchedulerOptions,
): Layer.Layer<TimerScheduler> =>
  Layer.effect(TimerScheduler, makeTimerScheduler(options));
