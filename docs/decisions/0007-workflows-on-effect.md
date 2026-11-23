# 0007 — Workflows on Effect: a Ballast WorkflowEngine and declaration layer

*Status: accepted for the stage 2 prototype · 2026-11-23 · effect `4.0.6` ·
new package `@ballast/workflow` · API revised to one-call `Workflow.make`*

## Context

Decision 0006 made one-shot wake-ups durable with `Ballast.Timer`. The next
stage is **multi-step resumable work**: a handler starts a sequence that may
sleep, wait for an external event, and continue after a service restart or a
hot reload.

The user direction is to use Effect's workflow model rather than invent a
bespoke step state machine:

> "Can we use a more Effect-workflow-style API, or even build on top of that?"

Effect 4.0.6 has the model. It does not have a durable engine usable by a
desktop service: `WorkflowEngine.layerMemory` is explicitly non-durable, and
`ClusterWorkflowEngine.layer` needs cluster sharding plus a SQL message-storage
driver. This decision asks whether a third party can implement
`WorkflowEngine` over a Ballast-owned store, and whether that is a better
foundation than named steps.

The answer is **yes for workflows, with an explicit declaration layer**:

- Define workflows in init so a restarted service can map a persisted execution
  back to its implementation.
- Keep activities inline in the workflow body, as ordinary Effect values. They
  are not part of the manifest; the engine journals their names, sequence
  position and schema hashes at runtime.
- Supply `@ballast/workflow` with a `WorkflowEngine` implementation over a
  pluggable store, plus `Workflow.sleep` (always durable) and a small
  declaration/registration layer.

The prototype lives in `packages/workflow`; a bespoke step machine is not
adopted.

## 1. Can a third party implement WorkflowEngine? Yes, through `Encoded`

Effect exposes two levels:

- the typed `WorkflowEngine` service
  (`effect/src/workflow/WorkflowEngine.ts` lines 40-223), whose methods are
  `register`, `execute`, `poll`, `interrupt`, `resume`,
  `activityExecute`, `deferredResult`, `deferredDone` and `scheduleClock`;
- the low-level `Encoded` contract and `makeUnsafe`
  (`WorkflowEngine.ts` lines 413-508 and 513-690). `makeUnsafe` owns the
  typed schema encode/decode around payloads, activity exits and deferred
  exits; an engine implementation works with encoded values and
  `Workflow.Result<unknown, unknown>`.

Implementing `Encoded` is the intended third-party path. The Ballast engine
does exactly that:
`packages/workflow/src/engine.ts` builds an `Encoded` object and returns
`WorkflowEngine.makeUnsafe(encoded)`.

The methods we implement and what they persist:

| Method | Ballast behaviour |
|---|---|
| `register(workflow, execute)` | Store the workflow tag → execute function in memory; resume any suspended execution for that tag. Registrations are not persisted; init re-registers them on every worker start |
| `execute(workflow, options)` | Create/load an execution record; start a run; discard starts a fiber and returns, non-discard waits for completion |
| `poll(workflow, executionId)` | Read the persisted status/result; return None while running, Suspended while parked, Complete when done |
| `interrupt`/`interruptUnsafe`/`resume` | Persist a suspended/interrupted status and interrupt or start the run fiber |
| `activityExecute(activity, attempt)` | Look up the journal at the current call position; return the stored result or run `activity.executeEncoded` and journal its encoded result |
| `deferredResult(deferred)` | Read the encoded `Exit` stored for `executionId + deferred.name` |
| `deferredDone(options)` | Store the encoded exit, persist, wake/restart a suspended run |
| `scheduleClock(workflow, { executionId, clock })` | Schedule a durable timer through `@ballast/core`'s `TimerScheduler`; persist the timer snapshot in the execution store |
| `awaitComplete(workflow, executionId)` | Wait on a per-execution completion deferred, so `Workflow.execute` does not use Effect's default retry sleep |

The prototype stores execution records with:

- encoded payload and script-generation fingerprint;
- status `running | suspended | complete`;
- an ordered activity journal: `{ position, name, schemaHash, result }`;
- deferred exits keyed by deferred name;
- encoded timer scheduler snapshot (clocks).

The reference stores are in-memory and JSON-file
(`packages/workflow/src/store.ts`). The JSON store is one file per script with
atomic replace.

### Where suspension happens

`Workflow.intoResult` (`effect/src/workflow/Workflow.ts` lines 704-800) turns
the run into a `Result`. It catches the deliberate self-interrupt from
`Workflow.suspend` (`Workflow.ts` line 1031) and returns
`Workflow.Suspended`. The suspension points are:

- `DurableDeferred.await` when `engine.deferredResult` returns None
  (`effect/src/workflow/DurableDeferred.ts` lines 166-180);
- an activity or child workflow that returns Suspended
  (`effect/src/workflow/Activity.ts` lines 322-350, via
  `Workflow.wrapActivityResult`).

The engine persists `Suspended` and ends that run. A later `deferredDone`,
clock fire or explicit resume starts the workflow implementation again from
the top. This is replay, not a saved instruction pointer.

### Replay model and activity journal

A replay starts the implementation at its first line. The engine keeps a
per-run activity cursor. For each activity call:

1. require the activity name to be unused in this run
   (`DuplicateActivityNameError` otherwise);
2. at journal position N, compare the current activity name and the SHA-256 of
   its success/error JSON Schemas with the journal entry;
3. if they match, return the stored encoded result without executing the body;
4. if they differ, apply the configured version policy;
5. if there is no entry, execute `activity.executeEncoded`, journal the result,
   and return it.

Only **completed** activities are journaled. A process crash mid-activity
leaves no journal entry, so the next replay runs it again. That is
at-least-once for activity bodies and must be documented in the workflow API;
external writes should be idempotent or keyed by the execution id.

This is also why activities do not need to be declared in init: their identity
is an execution-local contract, verified from the journal. Plan time cannot see
them, and does not pretend to.

## 2. Gaps fixed in Ballast's engine

### 2.1 Durable clocks for every duration

`DurableClock.sleep` has an in-memory fast path for durations at or below 60
seconds (`effect/src/workflow/DurableClock.ts` lines 95-121). The engine
cannot change that library branch. Ballast therefore exposes:

~~~ts
Workflow.sleep("hold", "30 seconds");
~~~

`packages/workflow/src/api.ts` implements it with
`DurableClock.make`, `WorkflowEngine.scheduleClock` and
`DurableDeferred.await` directly. It always writes a persisted clock, even for
milliseconds or seconds. Scripts should use `Workflow.sleep` inside workflows
and `Ballast.Timer` outside them; `Effect.sleep` and `DurableClock.sleep` are
not the durable API.

### 2.2 Activity execution is explicitly at-least-once

The journal is written only after a completed activity. A crash between the
side effect and the journal write re-runs the body. A crash after the journal
write returns the recorded result on replay. The engine and decision document
state this explicitly; activity names must be stable and external operations
should be idempotent. This is a deliberate trade-off, not hidden exactly-once
semantics.

### 2.3 Code/version safety

Every execution stores the engine's `fingerprint` (a script content hash plus
manifest/workflow declaration hash supplied by the host; tests use `"v1"` /
`"v2"`). On replay:

- workflow fingerprint mismatch applies `versionPolicy`;
- activity name or schema hash mismatch at a journal position applies the same
  policy;
- the policy is explicit:
  - `"abort"` (default): mark the execution complete as a failure with
    `WorkflowVersionMismatchError`;
  - `"continue"`: update the execution fingerprint/truncate the mismatched
    journal suffix and continue with current code;
  - `"migrate"`: invoke the host's `migrate(mismatch)` hook, then continue.

The engine never silently reinterprets an old journal. Plan output includes a
workflow fingerprint (schema hash) but cannot know activity schemas or body
changes; those are enforced at execution time.

### 2.4 Duplicate activity names

`Activity.make` has a name but no call-site identity. Two calls with the same
name in one run would address the same journal position ambiguously. Ballast
fails the run with `DuplicateActivityNameError` instead of guessing. Every
call site must use a distinct `Activity.make` name.

### 2.5 Waiting on Ballast events

A deferred that a topic handler resolves can be module-level:

~~~ts
const Done = Workflow.DurableDeferred.make("done", {
  success: Schema.Struct({ by: Schema.String }),
});

const Watch = yield* Workflow.make(
  "watch-chat",
  {
    payload: Schema.Struct({ id: Schema.String }),
    idempotencyKey: (payload) => payload.id,
  },
  (payload) =>
    Effect.gen(function* () {
      yield* Workflow.activity(
        "announce",
        Schema.Void,
        Effect.log("waiting for !done"),
      );
      const done = yield* Workflow.DurableDeferred.await(Done);
      yield* Effect.log("finished by " + done.by);
    }),
);

// a topic handler:
const executionId = yield* Watch.executionId({ id: redemptionId });
yield* Workflow.resolve(
  Watch,
  executionId,
  Done,
  Exit.succeed({ by: event.user_name }),
);
~~~

`Workflow.resolve` calls `WorkflowEngine.deferredDone` with the workflow tag,
execution id and deferred name. The engine stores the encoded exit, interrupts
a run waiting on that deferred, and replays the workflow. The deferred itself
is not in the manifest; it is a module-level handle shared by the workflow and
the topic handler. An inline deferred created only inside the workflow body
cannot be resolved from outside, which is the reason to hoist it.

## 3. Workflow declaration: inline vs init-registered

Both options were evaluated.

### (a) Inline/undeclared workflows

A workflow can be created without a manifest declaration and registered lazily
when first executed. The service learns about it only when it first runs.

| Property | Result |
|---|---|
| Plan visibility | None: the manifest cannot list the workflow, payload schema, or result schemas |
| UI before first run | No workflow entry, no pending/known workflow list |
| Consent | No place to show a new workflow or payload schema before it runs |
| Resume after restart | **Broken unless the implementation is registered on startup.** Effect's `Workflow.execute` only carries the definition; the execute function is registered separately. A handler may never run again, so a persisted execution has no implementation to map to |
| Code safety | The fingerprint can still be stored, but there is no declaration to compare at plan time |
| Authoring | Shortest for throwaway jobs |

### (b) Created in init (chosen)

`yield* Workflow.make(name, spec, body)` records the manifest entry and
registers the implementation in one call. The body can close over values
created in init. The same call on every worker start restores the tag →
implementation map that resume needs.

| Property | Result |
|---|---|
| Plan visibility | Workflow name, title, payload/success/error JSON Schemas and a schema fingerprint |
| UI before first run | Workflow appears in the script manifest; executions can be listed after the first start |
| Consent | New workflow declarations are visible; they do not add external scope themselves (requests inside activities still do) |
| Resume after restart | Works: init re-registers the tag before the engine resumes suspended records |
| Code safety | Engine fingerprint plus per-activity journal checks |
| Authoring | One `yield* Workflow.make(...)` call |

**Recommendation: declare workflows in init.** Resume requires registration
regardless of the manifest. Once registration is required, recording the
workflow is nearly free and gives plan-time visibility. The implementation
still supports lazy execution as a prototype convenience (`execute` does not
auto-register; an unregistered workflow fails loudly), but scripts should use
declaration.

Activities stay inline. Declaring them would force every activity body and
schema into init, duplicate implementation detail in the manifest, and still
not capture dynamic call order. The journal is the right verification point.

## 4. API

Package: `packages/workflow` (`@ballast/workflow`). It depends on
`@ballast/core` for the manifest recorder and timer scheduler; core does not
depend on it. Planner does not depend on it: workflow declarations write
through core's `ManifestRecorder`, and the manifest's `workflows` field is a
core schema. This keeps the workflow engine optional and avoids a dependency
cycle.

~~~ts
import * as Workflow from "@ballast/workflow";
import { Effect, Schema } from "effect";

const RedeemPayload = Schema.Struct({
  id: Schema.String,
  broadcaster_id: Schema.String,
  reward_id: Schema.String,
});

// init: create + register + handle in one call
const takeover = yield* Workflow.make(
  "redeem-takeover",
  {
    title: "Redeem Takeover",
    payload: RedeemPayload,
    success: Schema.Void,
    error: Schema.Never,
    idempotencyKey: (payload) => payload.id,
  },
  (payload) =>
    Effect.gen(function* () {
      const sceneName = yield* Workflow.activity(
        "get-original-scene",
        Schema.String,
        getCurrentScene,
      );

      yield* Workflow.activity(
        "restore-scene",
        Schema.Void,
        setScene(sceneName),
      );

      yield* Workflow.sleep("hold", "30 seconds");
    }),
);

// handler
yield* Twitch.ChannelPointsRedemption.subscribe("takeover-trigger", broadcaster, (event) =>
  takeover.execute(
    { id: event.id, broadcaster_id: event.broadcaster_user_id, reward_id: event.reward.id },
    { discard: true },
  ),
);
~~~

`Workflow.make` is the one-call API: it records the workflow in plan mode,
registers the implementation with `WorkflowEngine` at runtime, and returns a
handle. The body closes over init values (connection clients etc.). Activities
are inline; `Workflow.activity` is sugar over Effect's `Activity.make` and
takes an explicit success schema (use `Schema.Void` for no result). The handle
exposes `execute`, `executionId` and `resolve`. `Workflow.sleep` always
persists its clock.

## 5. Manifest impact

`Manifest` gains the additive `workflows` array; old manifests decode it as
`[]`:

~~~json
"workflows": [
  {
    "name": "redeem-takeover",
    "title": "Redeem Takeover",
    "payloadSchema": { "...": "JSON Schema" },
    "successSchema": { "...": "JSON Schema" },
    "errorSchema": { "...": "JSON Schema" },
    "fingerprint": "8c2cb076..."
  }
]
~~~

It does **not** contain activities, deferreds or sleeps. Plan time can verify:

- workflow names are unique;
- payload/success/error schemas are JSON-serializable and stable;
- the declaration fingerprint is stable.

Plan time cannot verify:

- activity names, count, order or schemas;
- whether a workflow actually reaches its sleep/deferred;
- whether an activity body is idempotent.

Those are runtime contracts enforced by the journal and version policy. This is
the main trade-off of keeping activities inline; the engine checks are explicit
and fail loudly.

## 6. Honest comparison with a bespoke step state machine

The previous proposal was a named-step machine: `{ step, nextStep, wait }`,
with a persisted cursor and explicit transitions.

| Criterion | Effect workflow (chosen) | Bespoke step machine |
|---|---|---|
| Durability | Persisted execution, journal, deferreds and clocks; replay | Persisted step cursor and waits; also durable |
| Author clarity | Ordinary Effect code, activities/sleep/deferred read naturally | Every transition must be named and encoded; more boilerplate |
| Plan visibility | Workflow declarations visible; activities/sleeps invisible until runtime | Full step graph could be manifest-visible at plan time |
| Verification | Activity journal position/name/schema hash, duplicate-name failure, fingerprint policy | Step names/order are explicit; must implement the same checks manually |
| Versioning | Journal-relative checks; code hash policy; activities can change shape but are detected at the next position | Step schema/version is naturally part of the state; migration still needed |
| Parallel/branching | Must respect Effect's replay model; parallel activity order is a hard problem | Explicit graph can branch cleanly |
| Ecosystem | Uses Effect's `Workflow`/`Activity`/`DurableDeferred` semantics and schemas | Ballast-specific abstraction forever |
| Implementation cost | Higher: custom engine, store, replay | Lower initially, but must grow step/version/parallel semantics |

Recommendation: **Effect workflows for stage 2**, because the engine interface
is workable and the API is the one the user asked for. Keep the step-machine
idea out unless a workflow requirement appears that Effect's replay model
cannot express (for example, arbitrary parallel activity ordering with a
deterministic journal). The current prototype limits itself to sequential
activities and top-level workflows.

## 7. Prototype implementation

`packages/workflow`:

- `src/api.ts` — one-call `make`, handle `execute`/`executionId`/
  `resolve`, `activity`, `sleep`, free `resolve`, re-exported Effect
  `Workflow`, `Activity`, `DurableClock`, `DurableDeferred`.
- `src/engine.ts` — `makeWorkflowEngine`, `layer`,
  `layerWithStore`, store-backed `Encoded` implementation, fingerprint
  policy, journal, deferred and clock handling.
- `src/store.ts` — `WorkflowStore` service, in-memory and JSON stores,
  snapshot schema.
- `src/index.ts` — exports.
- `test/workflow.test.ts` — 6 tests:
  1. activity → 5s durable sleep → activity completes; activities run once,
     and re-executing the same idempotency key returns the stored result;
  2. JSON store restart mid-sleep; first activity is not re-executed; second
     activity runs once after relaunch;
  3. deferred resolved by a simulated topic event resumes the workflow;
  4. fingerprint change with `"abort"` fails instead of replaying under new
     code;
  5. a persisted `running` record with no activity journal (crash mid-activity)
     re-runs the activity;
  6. duplicate activity name fails loudly.

Core/planner additions:

- `packages/core/src/manifest.ts` — `WorkflowManifestSchema`, `workflows`
  field, key.
- `packages/core/src/services.ts` and `packages/planner/src/recorder.ts` —
  `workflow` recorder entry.
- `packages/planner/src/diff.ts` — workflow diff.
- exact-manifest tests updated with `workflows: []`.

Example:

- `examples/redeem-takeover.ts` — redemption → get OBS scene activity → 30s
  durable sleep → restore scene → FULFILLED activity; failure path → CANCELED;
  idempotency key is the redemption id.
- `examples/tsconfig.json` and `examples/package.json` include
  `@ballast/workflow`.

Planned output of the example includes a `workflows` entry for
`redeem-takeover` and the new Twitch request scope
`channel:manage:redemptions` (from `helix/updateRedemptionStatus`); it does
not list activities.

## 8. Service integration spec

### 8.1 Where the engine runs

**The engine runs in the script worker; the store is behind RPC to the host.**

Why:

- activities are inline Effect code and already run in the worker, with the
  script's request clients, params and log context. Moving the engine to the
  host would require serializing every activity call and result across RPC and
  running Effect code in the host, duplicating the script environment.
- the engine needs the script's workflow implementation functions to replay;
  those live in the worker and are re-created by init.
- the host only needs to persist opaque snapshots and later start/resume a
  worker. It does not need to understand activity bodies.

On each worker start:

1. host starts the worker as it does today;
2. host provides a `WorkflowStore` service whose `load`/`save` call the host
   over runtime RPC (or a dedicated message channel);
3. script init evaluates each `yield* Workflow.make(...)`, registering the
   tag → implementation map with the engine;
4. the engine loads its store snapshot and resumes suspended executions for
   registered tags. Clocks are restored from the timer snapshot; overdue clocks
   fire according to the clock's late policy.

The engine creates its own `TimerScheduler` from `@ballast/core` with the
worker's `Clock`; no per-clock host RPC is needed. The snapshot, including
timer state, is saved through the store. If the worker is replaced mid-clock,
the new worker loads the pending clock and can fire it late.

### 8.2 Store location and format

**<project>/.ballast/workflows/<script-id>.json**, one file per script
(sanitize `/` in the script id or mirror the `applied/` naming rule). Use
`WorkflowStoreSnapshotSchema` from `@ballast/workflow`:

~~~json
{
  "version": 1,
  "executions": [
    {
      "executionId": "a1b2...",
      "workflowName": "redeem-takeover",
      "payload": { "id": "redemption-id" },
      "fingerprint": "script-content-hash+manifest-hash",
      "status": "suspended",
      "result": null,
      "activities": [
        {
          "position": 0,
          "name": "get-original-scene",
          "schemaHash": "ba86...",
          "result": {
            "_tag": "Complete",
            "exit": { "_tag": "Success", "value": "Game" }
          }
        }
      ],
      "deferreds": {},
      "clocks": { "version": 1, "timers": [ ... ] }
    }
  ]
}
~~~

- Atomic temp+rename, mode 0600, serialized per file.
- Completed executions can be pruned after a retention window (7 days
  suggested); suspended ones are kept.
- On script removal, delete the file; on project removal, delete the folder
  state without deleting the user's project files.
- On corrupt JSON: quarantine as `.corrupt-<timestamp>`, log, start empty.

### 8.3 Runtime RPC

Add (`@ballast/core` `RuntimeRpcs` or a Ballast-specific group):

- `LoadWorkflowStore({ scriptId }) -> WorkflowStoreSnapshot`
- `SaveWorkflowStore({ scriptId, snapshot }) -> void`
- optionally `ListWorkflowExecutions` for diagnostics; the host can also read
  the file directly.

The host must validate the snapshot with `WorkflowStoreSnapshotSchema` before
writing it. The worker should save after every state transition: run start,
activity journal append, suspension, deferred completion, clock completion and
completion. Saves are whole-file snapshots in the reference implementation;
batch/serialize later if needed.

Add a worker command/host RPC for `CancelWorkflow({ scriptId, executionId })`
that calls `WorkflowEngine.interrupt`; the engine persists the suspended state
and the host updates the UI.

### 8.4 Fingerprint and policy

The host supplies the engine fingerprint per generation:

- script content hash + manifest workflow fingerprint (and provider versions if
  desired);
- `versionPolicy: "abort"` by default;
- expose an explicit migration action in Settings/Script detail: re-run under
  `"continue"` or supply a host `migrate` hook. Never silently replay under
  changed code.
- On abort, the execution's failure result should carry
  `WorkflowVersionMismatchError` with previous/current fingerprint and reason
  (workflow, activity name, or activity schema).

### 8.5 UI/API surface

Additive proposal for `@ballast/agent-protocol` (not edited here):

~~~ts
interface WorkflowExecutionSummary {
  projectId: string;
  scriptId: string;
  executionId: string;
  workflowName: string;
  status: "running" | "suspended" | "complete";
  startedAt: number;
  updatedAt: number;
  fingerprint: string;
  lastError?: string;
  activityCount: number;
  waitingFor?: string; // deferred name or clock name
}

interface ListWorkflowExecutions {
  projectId?: string;
  scriptId?: string;
  includeFinished?: boolean;
}

interface CancelWorkflow {
  projectId: string;
  scriptId: string;
  executionId: string;
}
~~~

- Script detail shows declared workflows (name, payload/result schema) and
  executions (status, activity timeline, deferred wait, clock due time).
- Event inspector emits `workflow-started`, `workflow-suspended`,
  `workflow-resumed`, `workflow-activity`, `workflow-completed`,
  `workflow-failed`.
- Settings shows the default version policy and the “migrate/re-run” action.
- Do not show activity bodies; show names, positions, schema hashes and
  completion status only.

### 8.6 Service tests to add

1. Start a worker, register a workflow, execute a 30-second sleep, stop the
   worker mid-sleep, start a new worker, assert the second activity runs once
   and the first is not re-executed.
2. Resolve a module-level deferred from a topic event and assert replay
   completes.
3. Change the script fingerprint and assert `abort` fails visibly; test
   `continue` and a migration hook.
4. Cancel a suspended workflow and assert no activity runs.
5. Corrupt the store and assert quarantine.
6. Remove the script/project and assert store cleanup.
7. Ensure a hot reload mid-activity re-runs that activity (at-least-once) and
   does not duplicate already-journaled activities.

## 9. Prototype limitations

The prototype is intentionally narrow; these are explicit, not hidden:

- **Sequential activities only.** The journal is indexed by call position.
  Concurrent activities can complete in different orders; a later revision must
  use deterministic activity ids or a different journal key.
- **Top-level workflows only.** Child workflow linkage/parent completion is not
  implemented. `Encoded.execute` accepts a parent but does not link it.
- **Non-discard `execute` waits for completion.** This is convenient for a
  caller but means a parent workflow calling a child would block rather than
  suspend. Use `discard: true` or add proper parent linkage before relying on
  nested workflows.
- **Activity failures are stored as a message.** The result store simplifies
  failure exits; the full Effect cause is available in-process but not
  faithfully serialized. Success paths and fingerprint aborts are covered.
- **No plan-time activity validation.** Activities are inline by design; the
  engine validates only at execution. This was a deliberate user choice.
- **Deferred handles must be reachable from the resolver.** Create them at
  module level (or capture them in the topic handler); a deferred created only
  inside the workflow body cannot be resolved externally.
- **No exactly-once activity execution.** A crash before the journal write
  re-runs the activity; document idempotency at call sites.
- **No code hot-swap of a running fiber.** Replay is per run; an old run cannot
  be edited in place.

## 10. Verification

Commands run from the repository root:

~~~
pnpm --filter @ballast/workflow typecheck
pnpm --filter @ballast/workflow test
  Test Files  1 passed (1)
       Tests  6 passed (6)

pnpm --filter @ballast/core typecheck && pnpm --filter @ballast/core test
  Test Files  2 passed (2)
       Tests  15 passed (15)

pnpm --filter @ballast/planner typecheck && pnpm --filter @ballast/planner test
  Test Files  2 passed (2)
       Tests  16 passed (16)

pnpm --filter @ballast/examples typecheck
pnpm typecheck
pnpm test
  all workspace tests passed when run before the service agent's latest timer
  test landed; a later run fails only in
  apps/agent/test/timers.test.ts ("drops a stale timer after the max age",
  1m timeout) from the concurrent service workstream
~~~

The example plans with:

~~~
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts plan examples/redeem-takeover.ts
~~~

showing `workflows: [{ name: "redeem-takeover", ... }]`, the Twitch request
`helix/updateRedemptionStatus` with scope `channel:manage:redemptions`, and
the OBS `obs/*` grant. Activities are intentionally absent from the manifest.

## 11. Suggested documentation addition (not applied)

`AGENTS.md`:

> Multi-step durable work uses `@ballast/workflow`: declare the workflow in
> init, keep activities inline, use `Workflow.sleep` (not `Effect.sleep`) for
> sleeps, and resolve deferreds from handlers with `Workflow.resolve`.

The existing 0006 line about `Ballast.Timer` remains correct for one-shot
wake-ups; workflows use `Workflow.sleep` for continuations.
