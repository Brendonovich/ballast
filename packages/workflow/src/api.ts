import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { Scope } from "effect/Scope";
import type { Input as DurationInput } from "effect/Duration";
import {
  ManifestRecorder,
  Runtime as BallastRuntime,
  captureSource,
  currentPhase,
  provideRuntime,
} from "@ballast/core";
import type { WorkflowManifest } from "@ballast/core";

export { Activity, DurableClock, DurableDeferred, Workflow };

/** Schemas used by a durable workflow must be JSON and use no codec services. */
export interface NoServices {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}

export interface WorkflowHandle<
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top & NoServices,
  Error extends Schema.Top & NoServices,
> {
  readonly workflow: Workflow.Workflow<Tag, Payload, Success, Error>;
  readonly title: string | undefined;
  readonly execute: <const Discard extends boolean = false>(
    payload: Payload["~type.make.in"],
    options?: {
      readonly discard?: Discard;
      readonly detached?: [Discard] extends [true] ? boolean | undefined : undefined;
    },
  ) => Effect.Effect<
    Discard extends true ? string : Success["Type"],
    Discard extends true ? never : Error["Type"],
    BallastRuntime
  >;
  readonly executionId: (payload: Payload["~type.make.in"]) => Effect.Effect<string>;
  /** Resolve a deferred that the workflow is waiting on. */
  readonly resolve: <
    DeferredSuccess extends Schema.Top & NoServices,
    DeferredError extends Schema.Top & NoServices,
  >(
    executionId: string,
    deferred: DurableDeferred.DurableDeferred<DeferredSuccess, DeferredError>,
    exit: Exit.Exit<DeferredSuccess["Type"], DeferredError["Type"]>,
  ) => Effect.Effect<void, never, BallastRuntime>;
}

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

const toManifest = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top & NoServices,
  Error extends Schema.Top & NoServices,
>(
  workflow: Workflow.Workflow<Tag, Payload, Success, Error>,
  title: string | undefined,
): WorkflowManifest => {
  const payloadSchema = Schema.toJsonSchemaDocument(workflow.payloadSchema);
  const successSchema = Schema.toJsonSchemaDocument(workflow.successSchema);
  const errorSchema = Schema.toJsonSchemaDocument(workflow.errorSchema);
  return {
    name: workflow._tag,
    ...(title === undefined ? {} : { title }),
    payloadSchema,
    successSchema,
    errorSchema,
    fingerprint: hash([workflow._tag, payloadSchema, successSchema, errorSchema]),
  };
};

/**
 * Create and register a workflow in init, returning its handle. The body is
 * an ordinary Effect and is never evaluated during planning.
 *
 * This is the one-call API: it matches `Topic.subscribe` and
 * `Timer.subscribe`, and the body can close over values created in init
 * (connections, params, request clients).
 */
const registry = new Map<string, Workflow.Any>();

export const workflowByName = (name: string): Workflow.Any | undefined =>
  registry.get(name);

export const make = <
  const Tag extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top & NoServices = Schema.Void,
  Error extends Schema.Top & NoServices = Schema.Never,
>(
  name: Tag,
  options: {
    readonly title?: string;
    readonly payload: Schema.Struct<Fields> & NoServices;
    readonly success?: Success;
    readonly error?: Error;
    readonly idempotencyKey: (payload: Schema.Struct.Type<Fields>) => string;
  },
  execute: (
    payload: Schema.Struct.Type<Fields>,
  ) => Effect.Effect<
    Success["Type"],
    Error["Type"],
    | WorkflowEngine.WorkflowEngine
    | WorkflowEngine.WorkflowInstance
    | Scope
    | BallastRuntime
  >,
): Effect.Effect<
    WorkflowHandle<Tag, Schema.Struct<Fields> & NoServices, Success, Error>
  > => {
  const source = captureSource(2);
  return Effect.gen(function* () {
    const workflow = Workflow.make<
      Tag,
      Schema.Struct<Fields> & NoServices,
      Success,
      Error
    >(name, {
      payload: options.payload,
      idempotencyKey: options.idempotencyKey,
      ...(options.success === undefined ? {} : { success: options.success }),
      ...(options.error === undefined ? {} : { error: options.error }),
    });
    registry.set(workflow._tag, workflow);
    const manifest = {
      ...toManifest(workflow, options.title),
      ...(source === undefined ? {} : { source }),
    };

    const engine = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine);
    if (Option.isSome(engine)) {
      yield* Effect.scoped(
        engine.value.register(workflow, (payload, _executionId) =>
          provideRuntime(execute(payload)),
        ),
      );
    } else {
      const phase = yield* currentPhase;
      if (phase === "runtime") {
        return yield* Effect.die(
          new Error(
            `Workflow "${workflow._tag}" was created at runtime without a WorkflowEngine; the host must provide the Ballast workflow engine`,
          ),
        );
      }
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      if (Option.isNone(recorder)) {
        return yield* Effect.die(
          new Error(
            `Workflow "${workflow._tag}" was created during plan without a ManifestRecorder`,
          ),
        );
      }
      yield* recorder.value.workflow(manifest);
    }

    const executeHandle = <const Discard extends boolean = false>(
      payload: Schema.Struct.MakeIn<Fields>,
      execOptions?: {
        readonly discard?: Discard;
        readonly detached?: [Discard] extends [true] ? boolean | undefined : undefined;
      },
    ): Effect.Effect<
      Discard extends true ? string : Success["Type"],
      Discard extends true ? never : Error["Type"],
      BallastRuntime
    > =>
      Effect.serviceOption(WorkflowEngine.WorkflowEngine).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.die(
                new Error(
                  `Workflow "${workflow._tag}" was executed without a WorkflowEngine; the host must provide the Ballast workflow engine`,
                ),
              ),
            onSome: (service) =>
              workflow
                .execute(payload, execOptions)
                .pipe(
                  Effect.provideService(
                    WorkflowEngine.WorkflowEngine,
                    service,
                  ),
                  Effect.orDie,
                ),
          }),
        ),
      );

    const resolve: WorkflowHandle<
      Tag,
      Schema.Struct<Fields> & NoServices,
      Success,
      Error
    >["resolve"] = (
      executionId,
      deferred,
      exit,
    ) =>
      Effect.serviceOption(WorkflowEngine.WorkflowEngine).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.die(
                new Error(
                  `Workflow "${workflow._tag}" deferred "${deferred.name}" was resolved without a WorkflowEngine`,
                ),
              ),
            onSome: (service) =>
              service.deferredDone(deferred, {
                workflowName: workflow._tag,
                executionId,
                deferredName: deferred.name,
                exit,
              }),
          }),
        ),
      );

    return {
      workflow,
      title: options.title,
      execute: executeHandle,
      executionId: (payload) => workflow.executionId(payload),
      resolve,
    };
  });
};

/**
 * Sugar over Effect's `Activity.make`. The activity body is wrapped with
 * `Effect.orDie`, so declared activities have `Schema.Never` errors.
 */
export const activity = <A, E, R>(
  name: string,
  schema: Schema.Schema<A> & NoServices,
  execute: Effect.Effect<A, E, R | BallastRuntime>,
): Activity.Activity<
  Schema.Schema<A> & NoServices,
  Schema.Never,
  Exclude<R, BallastRuntime>
> =>
  Activity.make<Exclude<R, BallastRuntime>, typeof schema, typeof Schema.Never>({
    name,
    success: schema,
    execute: provideRuntime(execute).pipe(Effect.orDie),
  });

/** Always-durable sleep. Unlike DurableClock.sleep, this never uses the <60s in-memory path. */
export const sleep = (name: string, duration: DurationInput): Effect.Effect<
  void,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const instance = yield* WorkflowEngine.WorkflowInstance;
    const clock = DurableClock.make({ name, duration });
    yield* engine.scheduleClock(instance.workflow, {
      executionId: instance.executionId,
      clock,
    });
    return yield* DurableDeferred.await(clock.deferred);
  });

/** Resolve a deferred from a topic handler; the engine resumes the suspended workflow. */
export const resolve = <
  Tag extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top & NoServices,
  Error extends Schema.Top & NoServices,
  DeferredSuccess extends Schema.Top & NoServices,
  DeferredError extends Schema.Top & NoServices,
>(
  handle: WorkflowHandle<Tag, Payload, Success, Error>,
  executionId: string,
  deferred: DurableDeferred.DurableDeferred<DeferredSuccess, DeferredError>,
  exit: Exit.Exit<DeferredSuccess["Type"], DeferredError["Type"]>,
): Effect.Effect<void, never, BallastRuntime> =>
  handle.resolve(executionId, deferred, exit);
