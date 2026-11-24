# 0012 — Project health: honest statuses, structured issues, contained failures

*Status: implemented · 2026-11-24 · API version 1*

## Context

A project is one worker generation over one manifest (0008). Until now the
service had a single `error` status with a free-form `lastError` and a
`needs-consent` status. That made unrelated problems look the same:

- a project with an OBS connection that was simply offline failed to start
  after ten seconds, because start waited for every connection;
- a run loop that threw marked the whole project failed;
- a failed edit while the previous worker kept running was reported as
  "running previous version" only by inferring from `enabled`;
- a worker that died after start left the project looking healthy;
- a failed request was an untyped string, so callers could only report it as a
  defect or a generic error.

The user-visible symptom was the chat-scenes project: OBS was bound but offline,
Twitch was connected, and the project reported `error` with
"Connection … did not connect within 10s" even though nothing was wrong with
the project itself. The desktop UI then showed "Running previous version" even
though generation 0 proved no worker had ever started.

This decision defines what "running", "failed" and "needs the user" mean when
parts of a project fail, and makes connection problems visible without gating
the worker.

## Status model

The project status is exactly one of:

| Status | Meaning |
| --- | --- |
| `stopped` | Enabled or not, no worker exists. Files may be ready to start. |
| `starting` | A start was requested and the service is planning/bundling/starting a worker. |
| `running` | A worker generation is alive and serving the applied manifest. |
| `needs-user` | A person must act before the project can start: bind a slot, approve a manifest, or fix missing connection state. |
| `failed` | Starting failed, or the worker exited after start. There is no worker. |

Rules:

- A project is `running` even when a connection is offline, a unit handler
  failed, or the latest edit did not apply. The worker is still the truth.
- `needs-user` outranks a stored `failed`/plan error while slots are unbound or
  consent is pending: the next action is the user's. A `stopped` project with
  unbound slots or a pending consent also reports `needs-user`; clients never
  infer setup from the absence of a worker.
- `starting` never survives the request that set it; start finishes as
  `running`, `needs-user` or `failed`.
- A worker exit after `running` sets `failed`. The service does not restart it
  automatically; the user starts or restarts the project.
- A failed edit while a worker exists does not change the status. The worker
  keeps serving the previous generation.

Compatibility aliases remain for older clients: `needs-consent` on the wire is
gone, but health still reports `needsConsent` (the number of projects with a
pending consent) and `error` (same as `failed`). New clients read the count
fields directly.

## Issues

Problems are data, not status text. Every project summary and detail carries:

~~~ts
interface ProjectIssue {
  id: string;            // stable per problem, e.g. "unit-failed:hype-loop"
  kind:
    | "connection-offline"
    | "unit-failed"
    | "change-not-applied"
    | "start-failed"
    | "worker-exited"
    | "needs-binding"
    | "needs-consent";
  severity: "warning" | "error";
  title: string;         // one line for a list
  detail?: string;       // provider message, diagnostic, exit reason
  unit?: string;         // named unit, for unit-failed
  integration?: string;  // "obs", "twitch", ... for slot issues
  slot?: string;         // project slot, for connection issues
  connectionId?: string; // service instance, when it exists
  source?: { file: string; line: number; column: number };
  at: number;
}
~~~

`ProjectSummary.issues` is canonical. `ProjectDetail.issues` repeats the same
array for screens that already fetch the detail. `lastError`,
`lastErrorKind`, and `lastErrorSource` are removed from the protocol.

Derived issues are recomputed whenever a summary or detail is read:

- `connection-offline` for a bound instance whose status is not `connected`;
- `needs-binding` for a declared slot with no binding;
- `needs-consent` when a manifest waits for approval.

Stored issues are the service's memory of things that happened:

- `change-not-applied` for the latest plan/edit failure, with the diagnostic's
  `source`;
- `start-failed` when a start attempt failed;
- `worker-exited` when a generation ended after ready;
- `unit-failed` per named unit that failed.

Stored issues are cleared by the event that makes them false: a successful
plan clears `change-not-applied`; a successful start clears
`start-failed`, `worker-exited` and `unit-failed`; a successful reconnect
clears `connection-offline` by being derived from live status instead.

## Connections never gate a start

Start requires two things only: every declared slot is bound, and the manifest
is approved. It does not require any connection to be connected.

- The worker starts, declares its subscriptions and reports ready.
- Subscriptions on an offline connection are registered with the router now and
  delivered when the connection comes back. Their unit status is `waiting`.
- A connection request made while the instance is disconnected fails
  immediately with typed `ConnectionUnavailable`; it does not wait ten seconds
  and it is not a defect.
- Connection reconnect and retry stay owned by the connection driver. Project
  start and stop never create or configure instances (0009).

The old `connections.ready` start gate is removed. The user-facing Connect
action still waits for its own connection, because that action is about the
connection.

## Typed connection request errors

`@ballast/core` exports two tagged errors:

~~~ts
class ConnectionUnavailable extends Data.TaggedError("ConnectionUnavailable")<{
  integration: string;
  slot: string;
  connectionId?: string;
  message: string;
}> {}

class ConnectionRequestFailed extends Data.TaggedError("ConnectionRequestFailed")<{
  integration: string;
  slot: string;
  connectionId?: string;
  message: string;
}> {}
~~~

`ConnectionRequestError` is their union. Request clients, the runtime RPC
`Request` method, the runtime worker and the service request handler all use
that channel. A failed request reaches the script as a typed error, so a
handler can choose to recover; if it does not, the runtime contains it as a
unit failure.

Subscribe, timer and `Ballast.run` handlers accept any error
(`Effect<void, unknown, Runtime>`). Handlers are not forced to catch
`ConnectionUnavailable`; an unhandled error is contained by the runtime and
recorded against the unit.

The errors have wire schemas and are converted with
`connectionRequestErrorFromWire`; the worker does not manufacture defects for
expected connection states. `connectionRequestError({...})` maps legacy driver
strings to the right tag by message, so integrations can be ported one at a
time.

## Failure containment

There is no project-wide failure mode for runtime work:

| Failure | Effect |
| --- | --- |
| A `Ballast.run` loop fails | The run unit gets `unit-failed`; the project stays `running` and other units keep working. |
| An event handler fails | The topic unit gets `unit-failed`; the failure is contained and logged, not a worker crash. |
| A timer handler fails | The timer unit gets `unit-failed`; the timer remains scheduled. |
| An API handler fails | Only that call fails. |
| A worker exits | The project becomes `failed` with `worker-exited`; no restart. |

The worker reports contained failures through a `UnitFailed` runtime RPC. The
host records the issue against the generation that produced it, so a late
failure from a replaced generation cannot poison the new one.

No automatic retry is added. A failed run stays failed until the project is
restarted; an offline connection retries because that is the connection
driver's job, not the project's.

## Units

`UnitStatus` is `active | waiting | failed`. `error` is gone.

- topics are `active` when the worker exists and the bound connection is
  `connected`, otherwise `waiting`;
- timers are `active` while a fire is pending, otherwise `waiting`;
- runs, workflows and databases follow the worker; a failed run is `failed`;
- params are always `active` once planned.

A failed unit carries an optional `lastError` copied from its issue.

## Service and UI behavior

- `HealthStatus.projects` now has `stopped`, `starting`, `running`,
  `needsUser` and `failed` counts, plus the aliases.
- The UI shows **one status word** for a project (`Stopped`, `Starting`,
  `Running`, `Needs you`, `Failed`) with an amber dot when a non-failed
  project has issues and a red dot when the project is `failed`. A running
  project with issues is still `Running`; there is no inferred "previous
  version" status.
- Clicking the status word opens an **issues popover**: one line per issue,
  errors first, with severity, a relative timestamp and a muted detail. Every
  line navigates to where the issue can be seen or fixed:
  `change-not-applied` to the source line, `unit-failed` to the unit's
  outline row and logs filter, `needs-consent` to the approval banner,
  `connection-offline` to the connection row, and `needs-binding` to the
  project requirement's picker.
- There is **no project error banner**. A `change-not-applied` issue marks its
  `source` line with a gutter marker and tooltip instead.
- Approving a pending consent on a stopped project enables and starts it, so
  the "Set up…" flow can go straight to approval. If other slots are still
  unbound, the result is `needs-user` again with `needs-binding` issues.
- MCP status maps `failed` to `error`, `needs-user` to
  `waiting_for_user`, and a running project with `change-not-applied` to
  `previous_version_running_latest_failed`.
- The protocol mock carries issues of every kind: a failed redemption unit and
  a failed change on the running Main Channel, a stopped Second Channel waiting
  on an unbound OBS slot, consent and an offline bound OBS topic, and a third
  project whose worker exited.

## Verification

The agent suite covers the behaviors above:

- a project bound to an offline OBS instance starts and reports `running`,
  with the topic unit `waiting` and a `connection-offline` issue; after the
  server comes up the issue clears, the unit becomes `active` and an event
  changes the OBS scene through a request;
- a throwing run is contained as `unit-failed` while another run stays
  `active` and the project stays `running`;
- a throwing event handler is contained as `unit-failed` on its topic while
  the project stays `running`;
- a worker that exits after ready sets `failed` with `worker-exited` and is
  not restarted;
- a broken edit over a live worker keeps `running` and `change-not-applied`
  with a `file:line` source, and a repair clears it;
- a Twitch cloud failure sets `lastError`, and recovery clears it without
  reconfiguring the connection.

`pnpm typecheck` and the agent, MCP and web unit suites are the gates.
