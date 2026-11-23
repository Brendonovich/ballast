import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TimerStoreSnapshotSchema } from "@ballast/core";

export const WorkflowExecutionStatusSchema = Schema.Literals([
  "running",
  "suspended",
  "complete",
]);
export type WorkflowExecutionStatus = Schema.Schema.Type<
  typeof WorkflowExecutionStatusSchema
>;

/**
 * One journaled activity call. `position` is the call's index in the current
 * workflow run, so replay can detect a changed activity order, a changed name
 * or a changed schema at the same position. `result` is an encoded
 * `Workflow.Result` (the activity's exit).
 */
export const WorkflowJournalEntrySchema = Schema.Struct({
  position: Schema.Number,
  name: Schema.String,
  schemaHash: Schema.String,
  result: Schema.Unknown,
});
export type WorkflowJournalEntry = Schema.Schema.Type<
  typeof WorkflowJournalEntrySchema
>;

export const WorkflowExecutionRecordSchema = Schema.Struct({
  executionId: Schema.String,
  workflowName: Schema.String,
  /** Encoded workflow payload. */
  payload: Schema.Unknown,
  /** Script/generation fingerprint that created the execution. */
  fingerprint: Schema.String,
  status: WorkflowExecutionStatusSchema,
  /** Epoch ms when the execution was created. */
  startedAt: Schema.optional(Schema.Number),
  /** Epoch ms of the last persisted transition. */
  updatedAt: Schema.optional(Schema.Number),
  /** Encoded `Workflow.Result` once complete. */
  result: Schema.optional(Schema.Unknown),
  activities: Schema.Array(WorkflowJournalEntrySchema),
  /** Encoded `Exit` values, keyed by DurableDeferred name. */
  deferreds: Schema.Record(Schema.String, Schema.Unknown),
  /** Deferred name/clock the execution is waiting on. */
  waitingFor: Schema.optional(Schema.String),
  /** Epoch ms when a clock wait is due. */
  dueAt: Schema.optional(Schema.Number),
  /** Failure summary for a completed failed execution. */
  lastError: Schema.optional(Schema.String),
});
export type WorkflowExecutionRecord = Schema.Schema.Type<
  typeof WorkflowExecutionRecordSchema
>;

export const WorkflowStoreSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  executions: Schema.Array(WorkflowExecutionRecordSchema),
  clocks: Schema.optional(TimerStoreSnapshotSchema),
});
export type WorkflowStoreSnapshot = Schema.Schema.Type<
  typeof WorkflowStoreSnapshotSchema
>;

export const emptyWorkflowStoreSnapshot = (): WorkflowStoreSnapshot => ({
  version: 1,
  executions: [],
});

export const decodeWorkflowStoreSnapshot = (input: unknown): WorkflowStoreSnapshot =>
  Schema.decodeUnknownSync(WorkflowStoreSnapshotSchema)(input);

/** Pluggable persistence for workflow execution records and clock timers. */
export interface WorkflowStoreService {
  readonly load: Effect.Effect<WorkflowStoreSnapshot>;
  readonly save: (snapshot: WorkflowStoreSnapshot) => Effect.Effect<void>;
}

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreService>()(
  "Ballast/WorkflowStore",
) {}

export const makeMemoryWorkflowStore = (
  initial: WorkflowStoreSnapshot = emptyWorkflowStoreSnapshot(),
): Effect.Effect<WorkflowStoreService> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    return {
      load: Ref.get(ref),
      save: (snapshot) => Ref.set(ref, snapshot),
    };
  });

export const memoryWorkflowStoreLayer = (
  initial: WorkflowStoreSnapshot = emptyWorkflowStoreSnapshot(),
): Layer.Layer<WorkflowStore> =>
  Layer.effect(WorkflowStore, makeMemoryWorkflowStore(initial));

const isMissingFile = (error: unknown): boolean =>
  Predicate.isObject(error) &&
  Predicate.hasProperty("code")(error) &&
  Predicate.isString(error.code) &&
  error.code === "ENOENT";

/**
 * Reference JSON store. Each script/project owns one file; the agent should
 * pass `<project>/.ballast/workflows/<script>.json`. Writes are atomic and a
 * missing file starts empty.
 */
export const makeJsonWorkflowStore = (
  path: string,
): WorkflowStoreService => {
  const load: Effect.Effect<WorkflowStoreSnapshot> = Effect.tryPromise({
    try: async () => {
      try {
        const text = await readFile(path, "utf8");
        return decodeWorkflowStoreSnapshot(JSON.parse(text));
      } catch (error) {
        if (isMissingFile(error)) return emptyWorkflowStoreSnapshot();
        throw error;
      }
    },
    catch: (error) => error,
  }).pipe(Effect.orDie);

  const save = (snapshot: WorkflowStoreSnapshot): Effect.Effect<void> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, path);
      },
      catch: (error) => error,
    }).pipe(Effect.orDie);

  return { load, save };
};

export const jsonWorkflowStoreLayer = (
  path: string,
): Layer.Layer<WorkflowStore> =>
  Layer.succeed(WorkflowStore, WorkflowStore.of(makeJsonWorkflowStore(path)));
