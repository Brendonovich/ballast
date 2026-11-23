# 0006 — Durable sleep: timers as events now, replayable workflows later

*Status: accepted for stage 1; stage 1 is implemented in `@ballast/core` and
`@ballast/planner` · 2026-11-23 · effect `4.0.6`*

## Context

A Ballast script is a plain Effect program. Init declares params, connections,
topics and request capabilities; handlers and `Ballast.run` loops do I/O. A
handler that writes

~~~ts
yield* Effect.sleep("10 minutes")
yield* doTheThing
~~~

loses `doTheThing` whenever its worker generation ends: a hot reload, a stop or
restart, an app update, a crash, or the machine sleeping and the service being
relaunched. The fiber is gone, so there is no continuation to resume.

The original request was to supply a durable sleep mechanism instead of
`Effect.sleep`. The useful question is not "can a timer survive a restart?"
(it can: persist a due time), but "what is the durable unit of work and how do
we make it explicit enough to verify?".

### The evaluation principle for this decision

Scripts are currently written by agents. Authoring effort is not a reason to
reject a design. Prefer designs where every durable step is **named and
declared**, every persisted value is **schema-typed**, and divergence or
non-determinism is **detectable** and fails loudly rather than producing a
plausible wrong result. This record applies that principle to both options.

A consequence: do not treat "the script author has to split the code into a
scheduler and a handler" as a downside. Treat it as a property that makes the
work visible to a planner, a UI and a test harness. What matters is whether the
runtime can persist the right state, replay or deliver it after a restart, and
detect when code or schemas changed underneath a pending sleep.

## Decision

**Stage 1 (implemented): durable timers are first-class events.** A script
declares a timer in init with a name, a schema-typed payload, a late-fire
policy and a max age. It schedules instances from handlers with an idempotency
key. The host persists instances per project and delivers fires like topic
events after a restart or reload. The API is `Ballast.Timer`.

**Stage 2 (not implemented): replayable workflows for multi-step durable
continuations.** If Ballast later needs "sleep, then continue with the code
after the sleep", it needs replay: re-run the handler from its start, skip the
steps whose results were persisted, and wake at the sleep. That is a workflow
engine. Effect 4.0.6 has the model but not a ready per-project engine for a
desktop service; adopting it is a separate phase with its own storage and
versioning work. The timer store and RPCs in stage 1 are the primitive that
stage 2 would use for its clocks.

**Rejected: a `Ballast.sleep(key, duration)` sugar that returns and continues.**
Without replay it cannot be honest. If it returns immediately, the code after
it runs at the wrong time. If it blocks the fiber, it is just `Effect.sleep`
with extra steps and loses the continuation on restart. It must not exist until
stage 2.

## Evidence: what Effect 4.0.6 provides

The installed package is `node_modules/.pnpm/effect@4.0.6/node_modules/effect`.
The workflow modules are exported from `effect/workflow` (see
`node_modules/.pnpm/effect@4.0.6/node_modules/effect/package.json` line 54).
There is no `effect/src/unstable/workflow` directory in this version; the
modules are at `effect/src/workflow`:

- `Workflow.ts`, `Activity.ts`, `DurableClock.ts`, `DurableDeferred.ts`,
  `DurableQueue.ts`, `WorkflowEngine.ts`, `WorkflowProxy.ts`,
  `WorkflowProxyServer.ts`.

### Workflow

`Workflow.make(tag, { payload, idempotencyKey, success?, error? })` creates a
workflow definition with a stable tag, schema-typed payload/result, and an
execution id derived from the tag and the idempotency key
(`workflow/Workflow.ts` lines 61, 340-341). The definition exposes
`execute`, `poll`, `interrupt`, `resume`, `executionId` and `toLayer`
(lines 100-170). `toLayer(execute)` registers the handler with a
`WorkflowEngine`. Workflows are durable because the engine stores execution
state and activity results, not because the original fiber survives.

### Activity

An `Activity` is a named Effect with success/error schemas whose completed
result is memoized by the engine during replay
(`workflow/Activity.ts` lines 1-9, 135-200). The source is explicit about the
limits: "Only completed activity results are memoized. If the activity suspends
while awaiting child workflows or a durable clock, its body runs again when the
parent workflow replays. Side effects before the suspension can repeat; make
those side effects idempotent." (lines 126-129). `Activity.idempotencyKey`
derives a deterministic key from the execution id, activity name and optionally
the attempt (lines 269-290).

That means every request a handler makes, and every other non-deterministic
read or write, must be wrapped in an activity with a stable name if the handler
is a workflow. An activity that is interrupted before completion re-runs, so
the external operation must be idempotent too.

### DurableClock

`DurableClock.sleep({ name, duration })` is not a magic continuation either.
It has a hard-coded in-memory threshold of 60 seconds
(`workflow/DurableClock.ts` lines 95-121):

- durations at or below 60 seconds run as an `Activity` whose body is
  `Effect.sleep`; they are **not durable**;
- longer durations call `engine.scheduleClock(instance.workflow, ...)` and then
  await the durable deferred named `DurableClock/<name>`.

The clock name becomes the deferred name. Two sleeps with the same name in one
execution therefore address the same deferred result; names must be unique
per execution path. That is an explicit, machine-checkable rule (and a good
example of why authoring effort is not the concern; the rule is visible).

### DurableDeferred

`DurableDeferred.await` registers the awaited deferred name on the instance,
reads `engine.deferredResult(self)`, and if there is no persisted result calls
`Workflow.suspend(instance)` (`workflow/DurableDeferred.ts` lines 140-178).
The engine later records a completion and wakes the workflow for replay. A
deferred completion is keyed by `executionId + deferred name`, so naming is
part of the persistence contract.

### Engines in 4.0.6

- `WorkflowEngine.layerMemory` is the only in-memory engine. Its own docs say
  it "keeps state only in memory and is not suitable for production workflows
  that require durability" (`workflow/WorkflowEngine.ts` lines 715-734). Its
  `scheduleClock` implementation uses `Effect.delay` and a local `FiberMap`
  (lines 976-984), so both the clock wake-up and the execution state are lost
  on restart.
- `ClusterWorkflowEngine.layer` is the durable implementation. It requires
  `Sharding.Sharding | MessageStorage`
  (`cluster/ClusterWorkflowEngine.ts` lines 1066-1076). Durable clocks are
  represented as cluster entity messages; activities, deferred completions and
  resumes are persisted through `MessageStorage`.
- `SqlMessageStorage` exists and persists cluster envelopes and replies in
  SQL; it requires `SqlClient.SqlClient`, `ShardingConfig` and `Crypto`
  (`cluster/SqlMessageStorage.ts` lines 33, 79, 1150-1191). There is no
  SQLite driver in this workspace: `pnpm-workspace.yaml` catalogs
  `effect`/`@effect/platform-node` but no `@effect/sql-sqlite-node`, and no
  package depends on one.
- `ClusterWorkflowEngine` does not persist a code version or a step-position
  contract. `payloadShape` is only used to warn when the same workflow tag is
  registered with a different payload shape (`ClusterWorkflowEngine.ts`
  lines 649-666, 1079-1085). Changing the handler between a sleep and its wake
  is not detected by the engine.

## Option A: run handlers as durable workflows

### What it would take

A handler would become a workflow execution per event, for example
`ballast:scriptId:subscriptionKey:eventId`. The workflow payload is the event;
init registers each subscription's workflow with `toLayer`. The handler body
is deterministic and every request is an `Activity`. `Ballast.run` loops are
not workflows (they never complete); they would remain ordinary fibers, or
become a sequence of child workflows with an explicit loop step.

`DurableClock.sleep` would then resume code after the sleep by replaying the
handler from the start. The host would need to persist execution state,
activity results and clock wake-ups per project, and expose poll/resume to the
service.

### Fit table

| Requirement | Workflow fit | Evidence / gap |
|---|---|---|
| Sleep resumes code after restart | Yes, in principle | Engine stores clock/deferred and replays; `DurableClock` + `DurableDeferred` |
| Determinism | Strong: control flow must be a pure function of the payload and persisted activity/deferred results | `Activity` only memoizes completed results; repeated side effects before suspension are documented |
| What is an activity | At minimum every request; also every time/random/env/param read that influences control flow, and any external write that must not repeat | Activity has a stable name and schemas; `idempotencyKey` helper |
| Event delivery | The event can trigger a workflow; delivery itself is not replayed | Requires an execution id and event-id dedupe; the current event bus has envelopes but no workflow execution mapping |
| Hot reload | Not handled by the engine | No code hash/version; a changed handler can replay old activity results in a different order. Ballast must add a manifest/code fingerprint and abort or migrate on mismatch |
| Storage | Cluster SQL or a custom engine | `layerMemory` is non-durable; `ClusterWorkflowEngine` needs `Sharding` + `MessageStorage`; no SQLite driver installed |
| Per-project state | Not provided | Cluster entities are machine-level; Ballast would need a project/script mapping and garbage collection |
| Plan-time checks | Possible and desirable, but not built | Declared activity names/schemas, stable sleep names, code/step contract, plan diff |
| Script API | Breaking | Every request/read becomes an activity; every handler becomes a workflow; `Effect.sleep` must be banned or wrapped |

### Verdict

Workflows are the right **long-term** model for a durable continuation. They are
not the right **first** implementation for Ballast because the engine and
storage are missing, and because adopting them is a breaking change to every
script and handler. The author burden is acceptable under the new principle;
the engine/storage/hot-reload work is the blocker.

The plan/runtime layers could be extended later without discarding stage 1:
`DurableClock.sleep` is itself a clock plus a deferred; the timer store is the
same primitive.

## Option B: durable timers as events (chosen)

A timer is a declared, schema-typed event with a persisted due time. The
continuation after the sleep is a **separate handler**, not hidden code after a
call. That is more explicit than a resumable-looking `sleep` and is fully
testable without replay.

### Script API

~~~ts
import * as Ballast from "@ballast/core";
import { Effect, Schema } from "effect";

const CooldownEnded = Schema.Struct({ user: Schema.String });

export default Effect.gen(function* () {
  const cooldown = yield* Ballast.Timer.subscribe(
    "cooldown",
    CooldownEnded,
    (fire) =>
      Effect.log(
        "cooldown ended for " + fire.payload.user +
          " (late by " + fire.lateByMs + "ms)",
      ),
    {
      title: "Cooldown",
      onStale: "deliver",
      maxAgeMs: 24 * 60 * 60_000,
    },
  );

  // in any handler or Ballast.run:
  yield* cooldown.after("user:" + userId, "10 minutes", { user: userId });
});
~~~

`Timer.subscribe` is the only declaration form: it declares the timer,
registers its handler and returns the handle. There is no separate define and
register step. <code>after</code> and <code>cancel</code> are I/O and must run in
handlers or `Ballast.run`. Calling either during plan dies with
`TimerCalledDuringPlanError`, the same rule as a request client.

The handle exposes:

~~~ts
interface Timer<A> {
  readonly name: string;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
  readonly payloadFingerprint: string;
  readonly after: (key: string, after: Duration.Input, payload: A) => Effect.Effect<void>;
  readonly cancel: (key: string) => Effect.Effect<void>;
}

interface TimerFire<A> {
  readonly timer: string;
  readonly key: string;
  readonly payload: A;
  readonly scheduledAt: number; // epoch ms
  readonly dueAt: number;       // epoch ms
  readonly firedAt: number;     // epoch ms
  readonly lateByMs: number;
}
~~~

### Semantics

- **Identity:** a timer instance is `(projectId, scriptId, timerName, key)`.
  Scheduling the same key replaces the due time, payload and scheduling time.
  Cancelling a missing key is a no-op.
- **Declaration vs instance:** the timer name and payload schema are declared in
  init and recorded in the manifest. Instances are dynamic and are not in the
  manifest. This keeps planning pure and lets the same declared timer have many
  per-user instances.
- **Payload:** encoded with `Schema.toCodecJson`, so the persisted form is
  canonical JSON. The manifest records the JSON Schema document and a SHA-256
  fingerprint of it. A pending instance carries the fingerprint it was
  scheduled with.
- **Late policy:** `onStale: "drop"` drops a fire older than `maxAgeMs`;
  `"deliver"` fires it once with `lateByMs`. Unlike a topic, the default is
  **deliver** and the default max age is **7 days**: a timer is a promise to run
  work, not a streaming event that goes stale after 60 seconds. This is an
  explicit policy per timer, recorded in the manifest.
- **Delivery:** at most once in the reference implementation. The store marks a
  timer `fired` before the host posts the fire to the worker. A crash in the
  narrow window between mark and post loses that fire; it never duplicates. The
  service integration section proposes an acknowledgement/outbox upgrade if
  at-least-once is needed later.
- **Ordering:** due timers are fired by `(dueAt, scriptId, timer, key)` order.
  There is no ordering guarantee with respect to topic events or other scripts.
- **No continuation:** the handler is a fresh invocation at fire time. It runs
  from the beginning, not from the line after a sleep.

### Why the timer event is honest

The scheduler persists the due time and payload; the worker is replaceable; the
handler is declared and can be re-registered after restart. Nothing pretends to
resume a fiber. A fire after a restart is ordinary event delivery, which the
host already knows how to do.

### Timers are also the primitive a workflow engine needs

Every `DurableClock.sleep` is implemented as a persisted clock/deferred in the
engine. Keeping that record per project, with a schema-typed payload and key,
is useful even if stage 2 never lands. Conversely, a workflow engine cannot
retrofit durability onto an in-memory fiber; it needs this store anyway.

## Manifest impact

The manifest gains one additive field:

~~~json
{
  "script": { "id": "scripts/cooldown" },
  "params": [],
  "connections": [],
  "topics": [],
  "requests": [],
  "unresolved": [],
  "timers": [
    {
      "name": "cooldown",
      "title": "Cooldown",
      "onStale": "deliver",
      "maxAgeMs": 86400000,
      "payloadSchema": {
        "dialect": "draft-2020-12",
        "schema": {
          "type": "object",
          "properties": { "user": { "type": "string" } },
          "required": ["user"],
          "additionalProperties": true
        },
        "definitions": {}
      },
      "payloadFingerprint": "d250dd32702b13d8b09acc226998622a4664001f09092aedc1ae95482928c3d7"
    }
  ]
}
~~~

Existing fields, topic/request/param shapes and the manifest's `requiresConsent`
rules are unchanged. The planner recorder de-duplicates timers by name and
normalizes them by name. `ManifestSchema` decodes a missing `timers` key to
`[]`, so applied manifests written before this decision still load. The diff
reports added/removed timers for the UI but **timer declarations do not require
consent**: they add no external scope or connection. Any request made inside a
timer handler still appears in that script's request/scopes manifest and still
requires consent through the normal rule.

### Consent position

Timers are local persistence and a local wake-up. They do not contact an
external service by themselves. The user should see them in the script detail
and in the pending-timer list, but requiring a consent prompt per declared timer
would add friction without adding a security boundary. If a future timer action
can call an integration, the call is already covered by that integration's
scope/connection consent.

## Persistence

**Location: `<project>/.ballast/timers.json`, one file per project.** This
matches `settings.json` and `applied/` in decision 0003, keeps timers next to
the script that owns them, and makes project removal naturally delete its
timer state. A service-level file would need to duplicate project identity and
garbage-collect deleted projects.

Format is the core `TimerStoreSnapshot`:

~~~json
{
  "version": 1,
  "timers": [
    {
      "scriptId": "scripts/cooldown.ts",
      "timer": "cooldown",
      "key": "user:42",
      "payload": { "user": "42" },
      "payloadFingerprint": "d250dd...",
      "scheduledAt": 1764000000000,
      "dueAt": 1764000600000,
      "onStale": "deliver",
      "maxAgeMs": 86400000,
      "state": "pending",
      "firedAt": 1764000600000,
      "lateByMs": 0
    }
  ]
}
~~~

`state` is `pending | fired | dropped`. `firedAt` and `lateByMs` are
written when the host takes a due timer. The file is written atomically
(temp file + rename, mode 0600) after every schedule, cancel, fire or drop.
The service may prune `fired`/`dropped` entries older than a retention window
(for example 7 days) at startup; pending entries are never pruned by age alone.

The entry stores the policy that was in effect when it was scheduled. Changing
a timer's declaration later does not silently rewrite existing instances; the
service reconciles them at the next generation using the fingerprint rule
below.

## Behaviour on lifecycle events

| Event | Behaviour |
|---|---|
| Service starts with `enabled: true` scripts | Load every project's `timers.json` before resuming scripts; start one scheduler; due instances remain `pending` until the script's new session calls `RegisterTimer`, then the policy is applied at delivery time |
| Script stop / disable | Keep pending instances; do not deliver to a stopped script. On the next start, a due instance is delivered late if `onStale: "deliver"` and within `maxAgeMs`; otherwise dropped |
| Script removed / project removed | Delete the script's instances from the project store (and the project file on removal) |
| Hot reload / generation change | Pending instances stay. New session re-registers timer names. Same declaration (same timer name and payload fingerprint) keeps instances; changed payload fingerprint drops them and logs `timer-schema-changed`; removed timer declaration drops pending instances and logs `timer-declaration-removed` |
| Handler code changed, declaration unchanged | Existing instances fire into the new handler. The timer name is the contract; the host does not try to version handler code in stage 1 |
| App update / service restart | Store reloads from disk; due instances follow the late policy. No fiber survives |
| Crash during delivery | At-most-once reference: a `fired` entry is not redelivered. A service that needs at-least-once should add an acknowledgement RPC and an outbox state (see integration spec) |
| Machine sleep / clock jumps forward | Wall-clock `dueAt` is compared with the current clock; all overdue instances are processed in due order and the late policy applies |
| Clock jumps backward | Timers wait until `dueAt` is reached again. `scheduledAt`, `dueAt` and `firedAt` are epoch milliseconds; monotonic durations are not persisted |
| Timer declaration added | No instances exist yet; only future <code>after</code> calls create them |
| Timer declaration removed | Pending instances are dropped with a log; the handler is no longer registered |

## Plan-time and test verification for AI-written scripts

The design is chosen to make these checks possible without executing handlers:

1. **Plan output is the declaration audit.** `ballast plan` now prints every
   timer name, policy, max age, payload JSON Schema and fingerprint. A CI
   snapshot or a manifest diff is enough to see that an agent declared the
   timer it intended.
2. **Plan is I/O-free and declaration-complete.** Scheduling, cancelling and
   request calls in init die with a typed error. A plan that succeeds cannot
   have scheduled a timer or called an integration from init. A timer enters the
   manifest when `Timer.subscribe` runs, so a timer cannot be declared without
   a handler (the host also rejects scheduling an undeclared timer).
3. **The host validates at the RPC boundary.** `ScheduleTimer` rejects an
   unknown timer name, a payload that does not encode against the declared
   schema, and a fingerprint that differs from the applied manifest. These are
   runtime checks, but they fail loudly and are cheap to test.
4. **The reference scheduler is deterministic under `TestClock`.** The core
   tests (below) prove schedule/fire, replace by key, cancel, serialise/restore
   across a simulated restart, and both late policies. An AI-written script's
   timer logic can be exercised with the same harness instead of waiting ten
   minutes.
5. **A lint rule should ban `Effect.sleep` in project scripts** (for work that
   must survive restart) and flag it in review. A plan cannot see inside a
   handler body, so this cannot be a planner check alone. Suggested rule:
   "Use `Ballast.Timer` for delays; `Effect.sleep` is only for short polling
   inside a single handler invocation." A test harness can grep the example
   and project sources as an additional guard.
6. **Future workflow stage:** the same principle would require declared
   activity names/schemas, unique durable step names, an execution code/version
   hash and a replay test from a recorded activity log. None of that is
   implemented here.

### Suggested one-line documentation additions (not applied)

- `AGENTS.md`: "Do not use `Effect.sleep` for work that must survive a
  restart; declare a `Ballast.Timer` and put the continuation in its handler."
- `docs/PLAN.md` §4 rules: "Delays that outlive a handler are durable timers,
  not `Effect.sleep`; timer declarations are part of the manifest."

### Recurring schedules (proposed, not implemented)

The same declaration and store can carry a recurrence. The intended API is:

~~~ts
const heartbeat = yield* Ballast.Timer.every(
  "heartbeat",
  "30 seconds",
  Schema.Struct({}),
  (fire) => Effect.log("heartbeat"),
);

const morning = yield* Ballast.Timer.cron(
  "morning",
  "0 9 * * *",
  Schema.Struct({}),
  (fire) => Effect.log("good morning"),
);
~~~

The manifest entry would add a `schedule` discriminant
(`{ kind: "every", everyMs }` or `{ kind: "cron", expression, timeZone }`).
The host would persist the same instance record plus the next `dueAt`, re-arm
from "now" after a fire, and never emit a burst of missed occurrences; a late
fire follows the same `onStale` policy as a one-shot timer. Cron needs an
explicit local-time-zone/DST decision before implementation. This is additive
to the current design and does not need workflows.

## Limits (stage 1)

- One-shot relative timers only (`after`). `every`/`cron` are proposed above
  but not implemented in the reference API.
- No exactly-once delivery; the reference store is at-most-once.
- No automatic rescheduling after a fire; a handler must call <code>after</code>
  again for a new instance.
- Keys are strings; keep them stable and bounded (recommended max 256 bytes).
- Payloads are canonical JSON; recommended max 16 KiB per timer.
- Suggested limits: 1,000 pending timers per script and 10,000 per project;
  reject schedules beyond 365 days; prune fired/dropped entries after 7 days.
- No delivery ordering guarantee across scripts or against topic events.
- The scheduler is per service; a timer belongs to the project/script that
  scheduled it. A script that is stopped for longer than `maxAgeMs` may lose
  its fire under `"drop"`; under `"deliver"` it fires late once on restart.
- Cron/interval schedules need a decision on local time zone, DST and catch-up
  bursts. Recommendation for the next step: re-arm from "now", never emit a
  burst of missed occurrences, and make that policy explicit in the
  declaration.

## Stage plan

1. **Now (this change):** timer declarations in the manifest; schedule/cancel
   RPCs; reference in-memory store/scheduler with persistence snapshots; timer
   events in the worker; example and tests. Agent-side service integration is
   specified below for the agent owner.
2. **Next, if needed:** `Timer.every` / `Timer.cron` as declared schedules,
   with the same store and a catch-up policy. This is a small extension of the
   store (a `schedule` field or a separate recurrence record) and does not need
   workflows.
3. **Later, only when a script genuinely needs a durable continuation:** a
   replayable workflow layer for handlers, with per-event executions, activity
   IDs for requests, a code/manifest hash per execution, and an explicit
   abort/migrate policy when code changes. This is a new engine/storage
   project, not a wrapper around `Effect.sleep`. Decision 0007 prototypes that
   engine on Effect's workflow API; the timer store here remains the clock
   primitive.

## Service integration spec (for the agent owner)

This section is the contract for `apps/agent` and `@ballast/agent-protocol`.
It is intentionally not implemented here because those packages are being
edited concurrently.

### Core contract to consume

From `@ballast/core`:

- `TimerStoreSnapshot`, `ScheduledTimer`, `TimerStoreSnapshotSchema`,
  `ScheduledTimerSchema`, `decodeTimerStoreSnapshot`;
- `TimerScheduler`, `TimerSchedulerService`, `makeTimerScheduler`,
  `timerSchedulerLayer`, `TimerFireRecord`, `TimerScheduleInput`;
- `RuntimeHostHandlers.scheduleTimer?`, `registerTimer?`, `cancelTimer?`;
- the worker message shape `{ kind: "timer", name, key, payload, scheduledAt,
  dueAt, firedAt, lateByMs }` (already handled by `runtime-worker`).

The new RPCs on `RuntimeRpcs` are `RegisterTimer`, `ScheduleTimer` and
`CancelTimer`. They are additive; existing hosts keep compiling because the
handlers are optional, but a host that does not implement them dies loudly when
a script uses a timer.

### Store format

Use exactly `TimerStoreSnapshot` for each project file:

~~~
<project>/.ballast/timers.json
{
  "version": 1,
  "timers": [
    {
      "scriptId": "scripts/cooldown.ts",
      "timer": "cooldown",
      "key": "user:42",
      "payload": { "user": "42" },
      "payloadFingerprint": "d250dd...",
      "scheduledAt": 1764000000000,
      "dueAt": 1764000600000,
      "onStale": "deliver",
      "maxAgeMs": 86400000,
      "state": "pending"
    }
  ]
}
~~~

- One file per project; `scriptId` is the project-relative id used in the
  applied manifest.
- Write temp file in the same directory, rename over the target, mode 0600.
  Serialize writes per project (a semaphore) so a schedule and a fire cannot
  interleave.
- On parse failure: log, rename the file to `timers.json.corrupt-<timestamp>`
  and start with an empty store. Do not delete the user's file silently.
- On startup, load stores before `ScriptManager.resumeEnabled`; merge into one
  service-level map keyed by `(projectId, scriptId, timer, key)`.
- On project removal, delete the file (or leave it with the project folder;
  removing a project must not delete the user's folder, but timer state should
  not be resurrected if the project is re-added later under a new id).

### Scheduler

A single `TimerManager` service per agent process:

- Own one `makeTimerScheduler` instance (or an equivalent scheduler) with the
  agent's `Clock`; pass `onFire` to route fires.
- On load, restore each project's snapshot into the full store. The reference
  scheduler coalesces to the earliest `dueAt` and wakes on schedule/restore.
- The core scheduler marks an entry `fired` **before** calling `onFire`.
  Therefore the service must not put entries for stopped or session-less
  scripts into the scheduler's live snapshot. Keep the full project store
  separately; when a script's session becomes ready, merge its runnable entries
  into the scheduler (a `restore` of the union), and when it stops, snapshot
  and restore the remainder. Otherwise a due entry for a stopped script would
  be marked fired without delivery.
- On fire: resolve the project, script and current manifest; validate the
  declaration and fingerprint; post the timer message to the active session.
  Re-evaluate the late policy at delivery time for any entry that was held.
- If a single global scheduler is preferred, own the loop with `fireDue` and a
  runnable filter instead of calling `onFire` for held entries. If the agent
  wants at-least-once delivery, it must add an acknowledgement RPC and an
  outbox (`state: "due"` + `deliveredAt`/ack). Do not silently change the
  core reference's at-most-once behavior without documenting it.
- Persist after every state transition. A crash between a schedule RPC and the
  disk write is a lost schedule; do the write before acknowledging
  `ScheduleTimer`.

### RPC handlers

`registerTimer({ name })`:

- Add the name to the session's timer subscription set.
- Validate that the current applied manifest declares it; reject unknown names
  with an error/log (the core RPC currently has no error channel; make it a
  loud failure or extend the schema with an error string).
- Flush any pending due fires for that `(project, script, timer)`.

`scheduleTimer({ name, key, delayMs, payload, payloadFingerprint, onStale,
maxAgeMs })`:

- Resolve the script from the session; require a running generation.
- Find the timer in the **applied manifest for the running generation**, not a
  newer planned manifest, and compare `payloadFingerprint` and policy. If they
  differ, fail with a string error so the worker can log/report it; do not
  accept a mismatched schema. (A plan may be newer than the running worker
  while consent is pending.)
- Validate `key` length, payload size, `delayMs >= 0`, and the future horizon.
- Upsert `(projectId, scriptId, name, key)` with `dueAt = now + delayMs`;
  persist; wake the scheduler.
- Scheduling is idempotent by key. A duplicate call replaces the old instance.

`cancelTimer({ name, key })`:

- Remove the instance if present; persist. Missing is a no-op.

Add the handlers to `startRuntimeSession` options and the host object in
`apps/agent/src/runtime-session.ts`. Add `deliverTimer` (or a generic
`deliver` with a discriminant) to `RuntimeSession`; the worker listener already
accepts `kind: "timer"`.

### Delivery message

The host must post this object to the worker (or call the equivalent session
method):

~~~ts
{
  kind: "timer",
  name: "cooldown",
  key: "user:42",
  payload: { user: "42" },
  scheduledAt: 1764000000000,
  dueAt: 1764000600000,
  firedAt: 1764000600123,
  lateByMs: 123
}
~~~

The worker decodes `payload` with the schema from the declaring handle and
dispatches to every handler subscribed to that name. A missing handler is
ignored; the instance is already marked fired on the host.

### Generation and hot reload

- Timer subscriptions belong to the session. On close, drop the session's
  subscription set, but **do not** delete the store entries.
- New generation: after `Ready`, the worker calls `RegisterTimer` for each
  subscribed timer; flush due entries then. Old and new sessions must not both
  receive a fire: only the active generation is in the router.
- Compare the timer declaration in the new manifest with the stored
  `payloadFingerprint`. Different: drop pending instances and log
  `timer-schema-changed`. Same: keep. Removed declaration: drop and log.
- A handler code change is not detected; the timer name is the contract. If the
  agent later adds a script content hash, log a warning when a pending timer
  survives a content change; do not silently reinterpret the payload.

### Stop / disable / remove

- Stop/disable: keep pending entries, stop delivering. On the next start the
  late policy applies at delivery time. This is intentionally the same rule as
  a service restart.
- Remove script: delete its entries and persist.
- Remove project: delete the project file; remove in-memory entries.
- Uninstall: no special handling; the file lives in the project.

### UI / API surface

`@ballast/agent-protocol` is owned by another agent. Additive suggestions:

- `ScriptManifest.timers: Array<{ name, title?, onStale, maxAgeMs,
  payloadFingerprint }>` on the script detail; the payload JSON Schema can be
  included for an inspector but is not required for the summary.
- A service/script timer list:
  ~~~ts
  interface TimerSummary {
    projectId: string;
    scriptId: string;
    timer: string;
    key: string;
    dueAt: number;
    scheduledAt: number;
    onStale: "drop" | "deliver";
    maxAgeMs: number;
    state: "pending" | "fired" | "dropped";
    lastFiredAt?: number;
    lateByMs?: number;
  }
  interface ListTimers { projectId?: string; scriptId?: string; includeFinished?: boolean }
  interface CancelTimer { projectId: string; scriptId: string; timer: string; key: string }
  ~~~
- The script detail screen should show pending timers with a countdown, the key,
  the payload preview, the policy and a Cancel action. A timer fire can also
  emit a `ServiceEvent` (`timer-fired`) for the event inspector.
- Do not expose mutation of timer declarations from the UI; declarations come
  from the script manifest.

### Service tests to add

1. Start the real service against a temp project; plan a script with the
   example timer; assert `ListTimers`/script detail includes it.
2. Schedule through a running worker; rewrite `timers.json`; stop the service;
   start it again; assert the timer fires after its due time (use a short test
   duration and a fake/controllable clock at the service boundary).
3. Restart mid-window; assert the same key does not duplicate.
4. Stop/disable the script before due; assert no delivery; enable after due and
   assert the policy (drop vs deliver).
5. Remove the project; assert the file/entries are gone and no scheduler wake
   remains.
6. Change the payload schema in the script; assert pending entries are dropped
   and logged, not decoded as the new schema.
7. Corrupt `timers.json`; assert quarantine and a clean start.
8. Generation swap around a due time; assert exactly one generation receives
   the fire.

## Rejected alternatives

- **A host-side `Effect.sleep` replacement that blocks the fiber.** It still
  loses the continuation; it only moves the timer into the host.
- **A `Ballast.sleep` that returns a deferred and then code continues.** Code
  after it runs immediately; if it blocks, it is not durable.
- **Storing only per-service absolute timestamps with no script identity.**
  Hot reload and project removal cannot be reasoned about; the manifest
  fingerprint cannot be checked.
- **Running every handler as a workflow now.** Engine/storage/hot-reload work
  is not ready; it changes every script and cannot be implemented in core and
  planner only.

## Open questions

1. Should the service upgrade timer delivery to at-least-once with an
   acknowledgement/outbox? What duplicate-suppression key should the handler
   receive (`scriptId + timer + key + dueAt`)?
2. Should `Timer.every`/`cron` live in the same declaration (a `schedule`
   field) or be a separate recurring-timer store? Local time zone/DST policy
   must be explicit.
3. How should a deliberate code migration preserve pending timers whose payload
   schema changed? A future `migrate` handler could map old payloads; v1 drops
   them loudly.
4. Should timer declarations require a consent/visibility prompt when the
   script can schedule work autonomously? Current decision: no new consent
   because no external scope is added, but the UI must list pending timers.
5. If stage 2 workflows land, do event handlers become a workflow per event, or
   only explicit `Ballast.Durable` calls? Per-event workflows have a cost for
   every chat message/tick; explicit opt-in is likely better.

## Implementation files

- `packages/core/src/manifest.ts` — additive `TimerManifest`, `timers` field,
  `timerManifestKey`; decoding default for old manifests.
- `packages/core/src/services.ts` — `ManifestRecorderService.timer`.
- `packages/core/src/timer.ts` — `Timer.subscribe`, plan/runtime host layers,
  payload schema/fingerprint, `TimerFire`, `TimerRuntime`.
- `packages/core/src/timer-store.ts` — persisted snapshot schema, reference
  scheduler, TestClock-friendly clock injection, late policy.
- `packages/core/src/script.ts` — `TimerHost` added to the script host
  services; plan/runtime layers.
- `packages/core/src/runtime-rpc.ts` — `RegisterTimer`, `ScheduleTimer`,
  `CancelTimer`; optional host handlers for compatibility.
- `packages/core/src/runtime-worker.ts` — TimerRuntime implementation and
  `kind: "timer"` dispatch.
- `packages/core/src/index.ts` — exports.
- `packages/core/test/timer.test.ts` — plan, schedule/fire, replace, cancel,
  restart, late policy, runtime handle.
- `packages/planner/src/recorder.ts`, `diff.ts` — record/normalize/diff timers.
- `packages/planner/test/diff.test.ts`, `plan.test.ts` — timer diff and manifest.
- `packages/integrations/{obs,midi,keyboard,twitch,vtube-studio}/test/plan.test.ts`
  — updated exact manifest expectations with the additive `timers: []` field.
- `examples/timer-cooldown.ts`, `examples/tsconfig.json` — reference script.

## Verification

Commands run from the repository root:

~~~
pnpm --filter @ballast/core typecheck        # clean
pnpm --filter @ballast/core test             # 15 tests passed (2 files)
pnpm --filter @ballast/planner typecheck     # clean
pnpm --filter @ballast/planner test          # 13 tests passed (2 files)
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts plan examples/timer-cooldown.ts
~~~

The plan command prints the timer declaration with
`name: "cooldown"`, `onStale: "deliver"`, `maxAgeMs: 86400000`, a
`payloadFingerprint` of
`d250dd32702b13d8b09acc226998622a4664001f09092aedc1ae95482928c3d7`
and the payload JSON Schema for `{ user: string }`.

The root workspace also passed:

~~~
pnpm typecheck                               # clean
pnpm test                                    # all workspace tests passed (18/19 projects; e2e 3 skipped)
~~~

The integration plan tests that compare a whole manifest include the additive
`timers: []` field. The agent, desktop and web suites were run with the
concurrent workstream's tree and passed. The service integration is still
specified above rather than implemented, because `apps/agent` and
`packages/agent-protocol` are owned by that other workstream.
