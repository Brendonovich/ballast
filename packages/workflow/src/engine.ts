import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import type { Clock } from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { makeTimerScheduler } from "@ballast/core";
import type { TimerFireRecord, TimerStoreSnapshot } from "@ballast/core";
import {
  WorkflowStore,
  emptyWorkflowStoreSnapshot,
} from "./store.ts";
import type { WorkflowExecutionRecord, WorkflowStoreService } from "./store.ts";

/**
 * A durable Engine for Effect's workflow API.
 *
 * Replay model: an execution record stores the encoded payload, an ordered
 * activity journal (call position, name, schema hash, encoded result), encoded
 * deferred exits and encoded clock timers. A run always starts at the top of
 * the workflow implementation. Activities found at a journaled position return
 * their stored result; all other code (including activity calls before the
 * first journal entry) runs again. Suspension happens inside
 * `Workflow.intoResult` when `DurableDeferred.await` calls
 * `Workflow.suspend`, or when a child activity/workflow returns Suspended.
 */

export type WorkflowVersionPolicy = "abort" | "continue" | "migrate";

export type WorkflowMismatchReason = "workflow" | "activity" | "activity-schema";

export interface WorkflowVersionMismatch {
  readonly executionId: string;
  readonly workflowName: string;
  readonly reason: WorkflowMismatchReason;
  readonly previous: string;
  readonly current: string;
  readonly position?: number;
}

export class WorkflowVersionMismatchError extends Error {
  readonly executionId: string;
  readonly workflowName: string;
  readonly reason: WorkflowMismatchReason;

  constructor(mismatch: WorkflowVersionMismatch) {
    super(
      `Workflow "${mismatch.workflowName}" execution "${mismatch.executionId}" changed (${mismatch.reason}): ${mismatch.previous} -> ${mismatch.current}`,
    );
    this.name = "WorkflowVersionMismatchError";
    this.executionId = mismatch.executionId;
    this.workflowName = mismatch.workflowName;
    this.reason = mismatch.reason;
  }
}

export class WorkflowNotRegisteredError extends Error {
  readonly workflowName: string;

  constructor(workflowName: string) {
    super(
      `Workflow "${workflowName}" is not registered. Call Ballast Workflow.register in init so a restart can replay it.`,
    );
    this.name = "WorkflowNotRegisteredError";
    this.workflowName = workflowName;
  }
}

export class DuplicateActivityNameError extends Error {
  readonly executionId: string;
  readonly activityName: string;

  constructor(executionId: string, activityName: string) {
    super(
      `Activity "${activityName}" ran twice in workflow execution "${executionId}". Activity names must be unique within one run; use a distinct Activity.make name per call site.`,
    );
    this.name = "DuplicateActivityNameError";
    this.executionId = executionId;
    this.activityName = activityName;
  }
}

export interface WorkflowEngineOptions {
  readonly store: WorkflowStoreService;
  /** Host clock; pass the agent Clock or a TestClock. */
  readonly clock: Clock;
  /**
   * Hash of the script generation and its workflow declarations. Persisted on
   * every execution; a replay under a different fingerprint applies
   * `versionPolicy`.
   */
  readonly fingerprint: string;
  readonly versionPolicy?: WorkflowVersionPolicy;
  /**
   * Required for `"migrate"`: update/clear persisted state here, then the
   * engine continues with the current code and records the new fingerprint.
   */
  readonly migrate?: (mismatch: WorkflowVersionMismatch) => Effect.Effect<void>;
}

interface Registration {
  readonly workflow: Workflow.Any;
  readonly execute: (
    payload: object,
    executionId: string,
  ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>;
}

type MutableExecutionRecord = {
  executionId: string;
  workflowName: string;
  payload: unknown;
  fingerprint: string;
  status: WorkflowExecutionRecord["status"];
  startedAt: number | undefined;
  updatedAt: number | undefined;
  result?: unknown;
  activities: Array<WorkflowExecutionRecord["activities"][number]>;
  deferreds: Record<string, unknown>;
  waitingFor: string | undefined;
  dueAt: number | undefined;
  lastError: string | undefined;
};

interface ExecutionState {
  record: MutableExecutionRecord;
  typedResult: Workflow.Result<unknown, unknown> | undefined;
  fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined;
  completion: Deferred.Deferred<void> | undefined;
  activityIndex: number;
  seenActivities: Set<string>;
}

const ClockPayloadSchema = Schema.Struct({
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
});

const ExitCodec = Schema.toCodecJson(
  Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()),
);

const VoidExitCodec = Schema.toCodecJson(
  Schema.Exit(Schema.Void, Schema.Never, Schema.Defect()),
);

const encodeVoidExit = (): unknown =>
  Schema.encodeUnknownSync(VoidExitCodec)(Exit.void);

const StoredResultSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Suspended") }),
  Schema.Struct({
    _tag: Schema.Literal("Complete"),
    exit: Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("Success"),
        value: Schema.optional(Schema.Unknown),
      }),
      Schema.Struct({
        _tag: Schema.Literal("Failure"),
        message: Schema.String,
      }),
    ]),
  }),
]);

const encodeResult = (result: Workflow.Result<unknown, unknown>): unknown => {
  if (result._tag === "Suspended") return { _tag: "Suspended" };
  return result.exit._tag === "Success"
    ? { _tag: "Complete", exit: { _tag: "Success", value: result.exit.value } }
    : {
        _tag: "Complete",
        exit: { _tag: "Failure", message: Cause.pretty(result.exit.cause) },
      };
};

const decodeResult = (value: unknown): Workflow.Result<unknown, unknown> => {
  const stored = Schema.decodeUnknownSync(StoredResultSchema)(value);
  if (stored._tag === "Suspended") return new Workflow.Suspended({});
  return stored.exit._tag === "Success"
    ? new Workflow.Complete({ exit: Exit.succeed(stored.exit.value) })
    : new Workflow.Complete({ exit: Exit.fail(new Error(stored.exit.message)) });
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const hash = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const activitySchemaHash = (activity: Activity.Any): string => {
  const parts: Array<unknown> = [activity.name];
  if (
    Predicate.hasProperty("successSchema")(activity) &&
    Schema.isSchema(activity.successSchema)
  ) {
    parts.push(Schema.toJsonSchemaDocument(activity.successSchema));
  }
  if (
    Predicate.hasProperty("errorSchema")(activity) &&
    Schema.isSchema(activity.errorSchema)
  ) {
    parts.push(Schema.toJsonSchemaDocument(activity.errorSchema));
  }
  return hash(parts);
};

const stateKey = (executionId: string, name: string): string =>
  `${executionId}\u0000${name}`;

const decodePayload = (payload: unknown): object => {
  if (!Predicate.isObject(payload)) {
    throw new Error("Persisted workflow payload is not an object");
  }
  return payload;
};

const emptyRecord = (
  executionId: string,
  workflowName: string,
  payload: unknown,
  fingerprint: string,
  startedAt: number,
): MutableExecutionRecord => ({
  executionId,
  workflowName,
  payload,
  fingerprint,
  status: "running",
  startedAt,
  updatedAt: startedAt,
  waitingFor: undefined,
  dueAt: undefined,
  lastError: undefined,
  activities: [],
  deferreds: {},
});

/**
 * Build a WorkflowEngine backed by a store. The workflow implementation is
 * registered in init; workflows are not auto-discovered from the source.
 */
export const makeWorkflowEngine = (
  options: WorkflowEngineOptions,
): Effect.Effect<WorkflowEngine.WorkflowEngine["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const snapshot = yield* options.store.load;
    const executions = new Map<string, ExecutionState>();
    for (const record of snapshot.executions) {
      executions.set(record.executionId, {
        record: {
          ...record,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
          waitingFor: record.waitingFor,
          dueAt: record.dueAt,
          lastError: record.lastError,
          activities: record.activities.map((entry) => ({ ...entry })),
          deferreds: { ...record.deferreds },
          // A process that died while running did not finish the run.
          status: record.status === "running" ? "suspended" : record.status,
        },
        typedResult: undefined,
        fiber: undefined,
        completion: undefined,
        activityIndex: 0,
        seenActivities: new Set(),
      });
    }

    const registered = new Map<string, Registration>();
    const deferredState = WorkflowEngine.makeDeferredState();
    let engineService: WorkflowEngine.WorkflowEngine["Service"] | undefined;
    let handleClock: (fire: TimerFireRecord) => Effect.Effect<void> = () =>
      Effect.void;

    const scheduler = yield* makeTimerScheduler({
      clock: options.clock,
      ...(snapshot.clocks === undefined ? {} : { initial: snapshot.clocks }),
      onFire: (fire) => handleClock(fire),
    });

    const persist = Effect.gen(function* () {
      const now = options.clock.currentTimeMillisUnsafe();
      for (const state of executions.values()) {
        state.record.startedAt ??= now;
        state.record.updatedAt = now;
      }
      const clocks: TimerStoreSnapshot = yield* scheduler.snapshot;
      yield* options.store.save({
        version: 1,
        executions: [...executions.values()].map((state) => state.record),
        clocks,
      });
    });

    const currentEngine = (): WorkflowEngine.WorkflowEngine["Service"] => {
      if (engineService === undefined) {
        throw new Error("Workflow engine used before construction finished");
      }
      return engineService;
    };

    const completionOf = (state: ExecutionState): Deferred.Deferred<void> => {
      if (state.completion === undefined) {
        state.completion = Deferred.makeUnsafe<void>();
      }
      return state.completion;
    };

    const markComplete = (
      state: ExecutionState,
      result: Workflow.Result<unknown, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        state.record.status = "complete";
        state.record.result = encodeResult(result);
        state.record.lastError =
          result._tag === "Complete" && result.exit._tag === "Failure"
            ? Cause.pretty(result.exit.cause)
            : undefined;
        state.record.waitingFor = undefined;
        state.record.dueAt = undefined;
        state.typedResult = result;
        Deferred.doneUnsafe(completionOf(state), Exit.void);
        yield* persist;
      });

    const mismatchAction = (
      mismatch: WorkflowVersionMismatch,
    ): Effect.Effect<"abort" | "continue"> => {
      const policy = options.versionPolicy ?? "abort";
      if (policy === "continue") return Effect.succeed("continue");
      if (policy === "migrate") {
        return options.migrate === undefined
          ? Effect.succeed("abort")
          : options.migrate(mismatch).pipe(Effect.as("continue"));
      }
      return Effect.succeed("abort");
    };

    const failureResult = (
      mismatch: WorkflowVersionMismatch,
    ): Workflow.Result<unknown, unknown> =>
      new Workflow.Complete({
        exit: Exit.fail(new WorkflowVersionMismatchError(mismatch)),
      });

    const ensureFingerprint = (
      state: ExecutionState,
      workflow: Workflow.Any,
    ): Effect.Effect<Workflow.Result<unknown, unknown> | undefined> =>
      Effect.gen(function* () {
        if (state.record.fingerprint === options.fingerprint) return undefined;
        const mismatch: WorkflowVersionMismatch = {
          executionId: state.record.executionId,
          workflowName: workflow._tag,
          reason: "workflow",
          previous: state.record.fingerprint,
          current: options.fingerprint,
        };
        const action = yield* mismatchAction(mismatch);
        if (action === "abort") {
          const result = failureResult(mismatch);
          yield* markComplete(state, result);
          return result;
        }
        state.record.fingerprint = options.fingerprint;
        yield* persist;
        return undefined;
      });

    const startRun = (
      state: ExecutionState,
    ): Effect.Effect<Workflow.Result<unknown, unknown>> =>
      Effect.gen(function* () {
        const registration = registered.get(state.record.workflowName);
        if (registration === undefined) {
          return yield* Effect.die(
            new WorkflowNotRegisteredError(state.record.workflowName),
          );
        }

        const fingerprintResult = yield* ensureFingerprint(
          state,
          registration.workflow,
        );
        if (fingerprintResult !== undefined) return fingerprintResult;

        state.activityIndex = 0;
        state.seenActivities = new Set();
        state.record.waitingFor = undefined;
        state.record.dueAt = undefined;

        const payload = decodePayload(state.record.payload);
        const instance = WorkflowEngine.WorkflowInstance.initial(
          registration.workflow,
          state.record.executionId,
          { scope: Scope.forkUnsafe(scope) },
        );

        const exit = yield* registration
          .execute(payload, state.record.executionId)
          .pipe(
            Workflow.intoResult,
            (effect) => deferredState.trackRun(instance, effect),
            Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
            Effect.provideService(WorkflowEngine.WorkflowEngine, currentEngine()),
            Effect.exit,
          );

        if (Exit.isFailure(exit)) {
          return yield* Effect.die(exit.cause);
        }

        const result = exit.value;
        if (result._tag === "Complete") {
          yield* markComplete(state, result);
          return result;
        }

        state.record.status = "suspended";
        delete state.record.result;
        yield* persist;
        return result;
      });

    const ensureRun = (
      state: ExecutionState,
    ): Effect.Effect<Workflow.Result<unknown, unknown>> =>
      Effect.gen(function* () {
        if (state.fiber !== undefined) {
          const exit = yield* Fiber.await(state.fiber);
          if (Exit.isFailure(exit)) return yield* Effect.die(exit.cause);
          return exit.value;
        }
        const fiber = yield* Effect.forkIn(scope)(startRun(state));
        state.fiber = fiber;
        const exit = yield* Fiber.await(fiber);
        state.fiber = undefined;
        if (Exit.isFailure(exit)) return yield* Effect.die(exit.cause);
        return exit.value;
      });

    const completeDeferred = (
      executionId: string,
      deferredName: string,
      exit: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = executions.get(executionId);
        if (state === undefined) return;
        state.record.deferreds[deferredName] = exit;
        state.record.waitingFor = undefined;
        state.record.dueAt = undefined;
        yield* persist;
        yield* deferredState.deferredDone(executionId, deferredName);
        yield* Effect.forkIn(scope)(
          Effect.gen(function* () {
            if (state.fiber !== undefined) {
              yield* Fiber.await(state.fiber);
            }
            if (
              state.record.status === "suspended" &&
              registered.has(state.record.workflowName)
            ) {
              yield* ensureRun(state);
            }
          }),
        );
      });

    handleClock = (fire) => {
      const parsed = Schema.decodeUnknownSync(ClockPayloadSchema)(fire.payload);
      return completeDeferred(
        parsed.executionId,
        parsed.deferredName,
        encodeVoidExit(),
      );
    };

    const resumeSuspended = (workflowName: string): Effect.Effect<void> =>
      Effect.forEach(
        [...executions.values()].filter(
          (state) =>
            state.record.workflowName === workflowName &&
            state.record.status === "suspended",
        ),
        (state) => ensureRun(state).pipe(Effect.ignore),
        { discard: true },
      );

    function executeWorkflow<const Discard extends boolean>(
      workflow: Workflow.Any,
      opts: {
        readonly executionId: string;
        readonly payload: object;
        readonly discard: Discard;
        readonly parent?: WorkflowEngine.WorkflowInstance["Service"] | undefined;
        readonly detached?: boolean | undefined;
      },
    ): Effect.Effect<
      Discard extends true ? void : Workflow.Result<unknown, unknown>
    >;
    function executeWorkflow(
      workflow: Workflow.Any,
      opts: {
        readonly executionId: string;
        readonly payload: object;
        readonly discard: boolean;
        readonly parent?: WorkflowEngine.WorkflowInstance["Service"] | undefined;
        readonly detached?: boolean | undefined;
      },
    ): Effect.Effect<Workflow.Result<unknown, unknown> | void> {
      return Effect.gen(function* () {
        let state = executions.get(opts.executionId);
        if (state === undefined) {
          const record = emptyRecord(
            opts.executionId,
            workflow._tag,
            opts.payload,
            options.fingerprint,
            options.clock.currentTimeMillisUnsafe(),
          );
          state = {
            record,
            typedResult: undefined,
            fiber: undefined,
            completion: undefined,
            activityIndex: 0,
            seenActivities: new Set(),
          };
          executions.set(opts.executionId, state);
          yield* persist;
        }

        if (state.record.status === "complete") {
          const stored = state.typedResult ?? decodeResult(state.record.result);
          if (opts.discard) return yield* Effect.void;
          return stored;
        }

        if (opts.discard) {
          yield* Effect.forkIn(scope)(ensureRun(state).pipe(Effect.ignore));
          return yield* Effect.void;
        }

        const result = yield* ensureRun(state);
        if (result._tag === "Complete") return result;
        yield* Deferred.await(completionOf(state));
        return state.typedResult ?? decodeResult(state.record.result);
      });
    }

    const encoded: WorkflowEngine.Encoded = {
      register: (workflow, execute) =>
        Effect.gen(function* () {
          registered.set(workflow._tag, { workflow, execute });
          yield* Effect.forkIn(scope)(resumeSuspended(workflow._tag));
        }),
      execute: executeWorkflow,
      poll: (_workflow, executionId) => {
        const state = executions.get(executionId);
        if (state === undefined) return Effect.succeed(Option.none());
        if (state.record.status === "complete") {
          return Effect.succeed(
            Option.some(state.typedResult ?? decodeResult(state.record.result)),
          );
        }
        if (state.record.status === "suspended") {
          return Effect.succeed(Option.some(new Workflow.Suspended({})));
        }
        return Effect.succeed(Option.none());
      },
      interrupt: (_workflow, executionId) =>
        Effect.gen(function* () {
          const state = executions.get(executionId);
          if (state === undefined || state.record.status === "complete") return;
          state.record.status = "suspended";
          yield* persist;
          if (state.fiber !== undefined) {
            yield* Fiber.interrupt(state.fiber);
            state.fiber = undefined;
          }
        }),
      interruptUnsafe: (_workflow, executionId) =>
        Effect.gen(function* () {
          const state = executions.get(executionId);
          if (state === undefined || state.record.status === "complete") return;
          state.record.status = "suspended";
          yield* persist;
          if (state.fiber !== undefined) {
            yield* Fiber.interrupt(state.fiber);
            state.fiber = undefined;
          }
        }),
      resume: (_workflow, executionId) =>
        Effect.gen(function* () {
          const state = executions.get(executionId);
          if (state === undefined || state.record.status === "complete") return;
          yield* Effect.forkIn(scope)(ensureRun(state).pipe(Effect.ignore));
        }),
      awaitComplete: (_workflow, executionId) =>
        Effect.gen(function* () {
          const state = executions.get(executionId);
          if (state === undefined) return;
          if (state.record.status === "complete") return;
          yield* Deferred.await(completionOf(state));
        }),
      activityExecute: (activity, attempt) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const state = executions.get(instance.executionId);
          if (state === undefined) {
            return yield* Effect.die(
              new Error(`No execution ${instance.executionId} for activity ${activity.name}`),
            );
          }

          const name = activity.name;
          const schemaHash = activitySchemaHash(activity);
          if (state.seenActivities.has(name)) {
            return yield* Effect.die(
              new DuplicateActivityNameError(instance.executionId, name),
            );
          }
          state.seenActivities.add(name);

          const position = state.activityIndex;
          state.activityIndex++;

          const existing = state.record.activities.find(
            (entry) => entry.position === position,
          );
          if (existing !== undefined) {
            if (existing.name !== name || existing.schemaHash !== schemaHash) {
              const mismatch: WorkflowVersionMismatch = {
                executionId: instance.executionId,
                workflowName: state.record.workflowName,
                reason: existing.name !== name ? "activity" : "activity-schema",
                previous: `${existing.name}:${existing.schemaHash}`,
                current: `${name}:${schemaHash}`,
                position,
              };
              const action = yield* mismatchAction(mismatch);
              if (action === "abort") {
                return yield* Effect.die(new WorkflowVersionMismatchError(mismatch));
              }
              state.record.activities = state.record.activities.filter(
                (entry) => entry.position < position,
              );
              yield* persist;
            } else {
              return decodeResult(existing.result);
            }
          } else if (state.record.activities.length > position) {
            const mismatch: WorkflowVersionMismatch = {
              executionId: instance.executionId,
              workflowName: state.record.workflowName,
              reason: "activity",
              previous: state.record.activities[position]?.name ?? "missing",
              current: name,
              position,
            };
            const action = yield* mismatchAction(mismatch);
            if (action === "abort") {
              return yield* Effect.die(new WorkflowVersionMismatchError(mismatch));
            }
            state.record.activities = state.record.activities.filter(
              (entry) => entry.position < position,
            );
            yield* persist;
          }

          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
            { scope: Scope.forkUnsafe(scope) },
          );

          const exit = yield* activity.executeEncoded.pipe(
            Workflow.intoResult,
            Effect.provideService(
              WorkflowEngine.WorkflowInstance,
              activityInstance,
            ),
            Effect.provideService(
              WorkflowEngine.WorkflowEngine,
              currentEngine(),
            ),
            Effect.provideService(Activity.CurrentAttempt, attempt),
            Effect.exit,
          );

          if (Exit.isFailure(exit)) return yield* Effect.die(exit.cause);
          const result = exit.value;
          if (result._tag === "Suspended") return result;

          state.record.activities.push({
            position,
            name,
            schemaHash,
            result: encodeResult(result),
          });
          state.record.activities.sort((left, right) => left.position - right.position);
          yield* persist;
          return result;
        }),
      deferredResult: (deferred) =>
        Effect.gen(function* () {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const state = executions.get(instance.executionId);
          if (state === undefined) return Option.none();
          const value = state.record.deferreds[deferred.name];
          if (value === undefined) {
            state.record.waitingFor = deferred.name;
            state.record.dueAt = undefined;
            yield* persist;
            return Option.none();
          }
          return Option.some(Schema.decodeUnknownSync(ExitCodec)(value));
        }),
      deferredDone: (opts) =>
        completeDeferred(opts.executionId, opts.deferredName, opts.exit),
      scheduleClock: (workflow, opts) =>
        Effect.gen(function* () {
          const payload = {
            workflowName: workflow._tag,
            executionId: opts.executionId,
            deferredName: opts.clock.deferred.name,
          };
          const delayMs = Duration.toMillis(opts.clock.duration);
          const state = executions.get(opts.executionId);
          if (state !== undefined) {
            state.record.waitingFor = "clock:" + opts.clock.name;
            state.record.dueAt = options.clock.currentTimeMillisUnsafe() + delayMs;
          }
          yield* scheduler.schedule({
            scriptId: "workflow",
            timer: "workflow-clock",
            key: stateKey(opts.executionId, opts.clock.name),
            delayMs,
            payload,
            payloadFingerprint: "",
            onStale: "deliver",
            maxAgeMs: Number.MAX_SAFE_INTEGER,
          });
          yield* persist;
        }),
    };

    engineService = WorkflowEngine.makeUnsafe(encoded);
    return engineService;
  });

export const layer = (
  options: WorkflowEngineOptions,
): Layer.Layer<WorkflowEngine.WorkflowEngine> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    makeWorkflowEngine(options),
  );

/** A layer that resolves the store service from context. */
export const layerWithStore = (
  options: Omit<WorkflowEngineOptions, "store">,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, WorkflowStore> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      const store = yield* WorkflowStore;
      return yield* makeWorkflowEngine({ ...options, store });
    }),
  );

export const makeMemoryEngine = (
  options: Omit<WorkflowEngineOptions, "store"> & {
    readonly store?: WorkflowStoreService;
  },
): Effect.Effect<WorkflowEngine.WorkflowEngine["Service"], never, Scope.Scope | WorkflowStore> =>
  Effect.gen(function* () {
    const store = options.store ?? (yield* WorkflowStore);
    return yield* makeWorkflowEngine({ ...options, store });
  });

export const initialStoreSnapshot = emptyWorkflowStoreSnapshot;
