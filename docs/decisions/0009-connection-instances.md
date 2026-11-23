# 0009 — Connection instances and project slot bindings

*Status: implemented · 2026-11-23 · API version 1*

## Context

Decision 0008 made a project the unit of work: one bundle, one worker and one
manifest. Connection declarations are still part of a project manifest
(`Connection("main")`, `Account("broadcaster")`), but until now the slot name was
also the connection identity. That only works while each slot has one local
configuration. It breaks as soon as a user has two OBS machines, two Twitch
accounts or two projects that should use different instances of the same
integration.

Decision 0009 separates the two concepts:

- a **connection instance** is a configured integration owned by the service
  (credentials, mode, status, auth, driver, cloud registration);
- a **slot** is a project-local requirement declared in the manifest
  (`obs/main`, `twitch/broadcaster`);
- a **binding** maps a project slot to one service-level instance.

Instances and their drivers live at service scope. Starting, stopping or
reloading a project never creates, deletes or reconfigures an instance. It only
changes which instance satisfies the project's slot while it runs.

## Model

~~~ts
interface ConnectionInstance {
  id: string;            // opaque, e.g. "conn_9f2a1c4b7d10" or legacy "obs/main"
  integration: string;   // "obs" | "twitch" | "vts" | "fake" | ...
  label: string;         // user-facing, e.g. "Studio PC"
  config: Record<string, string>; // non-secret field values
  auth: { /* driver-owned: account, scopes, approval, mode */ };
  status: ConnectionStatus;
}
~~~

The wire shape is `ConnectionSummary`:

~~~ts
interface ConnectionBindingRef {
  projectId: string;
  slot: string;
}

interface ConnectionSummary {
  id: string;
  integration: string;
  title: string;
  label: string;
  location: "local" | "cloud" | "either";
  mode: "auto" | "local-app" | "cloud";
  status:
    | "unconfigured"
    | "disconnected"
    | "connecting"
    | "connected"
    | "reauth-required"
    | "error";
  fields: ConnectionField[];
  values: ConnectionValue[];
  scopes: { granted: string[]; required: string[]; missing: string[] };
  boundBy: ConnectionBindingRef[];   // project slot bindings
  account?: { id: string; login: string; displayName?: string; avatarUrl?: string };
  detail?: string;
  lastError?: string;
  lastConnectedAt?: number;
  approval?: ConnectionApproval;
  requiresAuth: boolean;
}
~~~

There is no `slot` field on an instance, and no `usedBy` script list. The
project-local identifier is always the requirement slot; the instance-local
identifier is opaque. Legacy records loaded from pre-0009 state keep their
`integration/slot` id, but the service treats every id as opaque.

## Requirements, proposals and bindings

A project manifest declares requirements exactly as before:

~~~ts
const obs = yield* OBS.Connection("main");
const broadcaster = yield* Twitch.Account("broadcaster");
~~~

`ProjectDetail.requirements` reports each requirement:

~~~ts
interface ProjectRequirement {
  integration: string;
  slot: string;
  location: "local" | "cloud" | "either";
  boundInstanceId?: string;     // explicit binding, if present
  proposedInstanceId?: string;  // only when exactly one matching instance exists
}
~~~

Rules:

1. A requirement with `boundInstanceId` is satisfied.
2. If it has no binding and exactly one instance of that integration exists,
   that instance is **proposed** (`proposedInstanceId`). A proposal is not a
   binding: it is not written to disk by `CheckProject`, planning or a file
   change.
3. A proposal becomes a binding only when the user starts the project or
   approves its pending consent. `StartProject` and `ApproveProjectConsent`
   both persist proposals through the same confirmation step.
4. A requirement with neither a binding nor a proposal blocks
   `StartProject` with a `conflict`. `CheckProject` reports it in
   `missingConnections`, and `ProjectDetail.requirements` shows it unbound.
5. Starting never silently picks an arbitrary instance. If two OBS instances
   exist and the slot is unbound, the user must bind one explicitly.

Bindings are stored per project at `.ballast/bindings.json`:

~~~json
{
  "version": 1,
  "bindings": {
    "obs/main": "conn_9f2a1c4b7d10",
    "twitch/broadcaster": "conn_2d77a0b1c4ee"
  }
}
~~~

The file is written atomically. It contains only explicit bindings; proposals
and unused requirements are not persisted. Removing a binding either unbinds
(`instanceId: null` through `SetProjectBinding`) or deletes the key.

## Lifecycle and routing

- Binding a running project restarts it through the normal generation path:
  the new generation registers topics against the new instance, and events are
  cut over with the usual worker grace period.
- Binding a stopped project changes only the stored binding and reconciles
  connection drivers; nothing starts until the user starts the project.
- Unbinding a running project stops it, because a running generation cannot
  have an unbound requirement. The project stays enabled so the next Start can
  bind it again.
- Requests from the worker carry the requirement slot; the runtime resolves the
  slot to the bound instance and passes `connectionId` to the connection
  manager. The driver uses its own instance for protocol calls.
- Inbound events carry `connectionId` plus the legacy `integration/slot/topic`
  coordinates. The event router matches a project subscription only when its
  bound instance equals the event's instance. Two projects bound to different
  OBS instances therefore receive only their own scene events.
- Connection summaries report `boundBy` from explicit bindings only. An
  unbound slot does not claim an instance even if its old id looked like
  `obs/main`.

### Twitch and cloud ownership

Twitch cloud subscriptions are reconciled per bound instance. The owner key is
`${projectId}/${slot}` and the cloud connection id belongs to the instance.
Changing a project's Twitch binding removes the old owner's subscriptions and
registers the new instance's. Projects that share an instance for the same slot
share its stream, but ownership is still tracked per project/slot.

Cloud Twitch instances do not require a client id or secret; those fields are
only for a local-app OAuth flow. The service maps an instance's account id back
to each project requirement slot when building EventSub conditions, so two
projects can bind the same Twitch account under different owner keys.

Instance ids are persisted verbatim in `connections.json`. After a restart the
service must keep the opaque `conn_...` id; deriving it from
`integration/slot` would break every saved project binding.

At startup, cloud buffered events can arrive before project workers restore
their subscriptions. The event router holds unmatched events during startup
warmup, then seeds each announced project subscription with the matching
events; it stops holding once `resumeEnabled` has completed.

HTTP webhooks follow the same rule: the webhook definition names the bound
instance, and inbound deliveries publish that instance id. A project whose HTTP
requirement is unbound cannot start and registers nothing.

## Deleting an instance

`DeleteConnection` refuses with `conflict` while any project slot is bound to
the instance:

~~~json
{
  "tag": "conflict",
  "message": "Connection \"Studio PC\" is bound to 1 project slot(s); unbind it first"
}
~~~

The user must unbind every slot first. The service does not silently unbind
projects, because a running project would otherwise lose its connection without
an explicit action.

## Protocol surface

### Connection instances

~~~ts
ListIntegrations(): {
  integrations: Array<{
    integration: string;
    title: string;
    location: "local" | "cloud" | "either";
    modes: ConnectionMode[];
    requiresAuth: boolean;
    fields: ConnectionField[];
    description?: string;
    redirectUrl?: string; // Twitch; always present: http://localhost:17345/callback
  }>;
}

ListConnections(): { connections: ConnectionSummary[] }
GetConnection({ connectionId: string }): ConnectionSummary

CreateConnection({
  integration: string;
  label: string;
  config: Record<string, string>; // field keys from the integration catalog
  mode?: ConnectionMode;
}): ConnectionSummary

UpdateConnection({
  id: string;
  label?: string;
  config?: Record<string, string>;
  mode?: ConnectionMode;
}): ConnectionSummary

DeleteConnection({ id: string }): void
~~~

`ConfigureConnection`, `ConnectConnection`, `DisconnectConnection` and
`StartConnectionAuth` continue to accept any instance id, including a legacy
id. They operate on the instance, never on a project slot.

### Project requirements and bindings

~~~ts
GetProject({ projectId }): ProjectDetail
// ProjectDetail gains:
//   requirements: ProjectRequirement[]

CheckProject({ projectId }): ProjectCheckResult
// new/changed fields:
//   requirements: ProjectRequirement[]
//   missingConnections: ProjectRequirement[]  // boundInstanceId === undefined
//   availableConnections: ConnectionSummary[]

SetProjectBinding({
  projectId: string;
  integration: string;
  slot: string;
  instanceId: string | null; // null removes the binding
}): ProjectDetail

ProjectConsentRequest {
  // existing fields ...
  bindings: ProjectBinding[]; // proposals that approval will persist
}

interface ProjectBinding {
  integration: string;
  slot: string;
  instanceId: string;
}
~~~

`ProjectDetail.requirements` and `ProjectConsentRequest.bindings` are the two
views the UI needs: the first is live state, the second is the exact set the
user approves.

## Legacy script surface removed

Project bundles fully replace the per-script service surface. The service no
longer exposes `ListScripts`, `GetScript`, `GetScriptSource`, `PlanScript`,
`StartScript`, `StopScript`, `RestartScript`, `SetScriptParam`,
`SetScriptEnabled`, `ListConsents`, `ApproveConsent` or `RejectConsent`.
`ScriptManager` and `apps/agent/src/service/scripts.ts` are gone, as are the
legacy `ProjectSummary.scriptCount` and `ProjectDetail.scripts` fields,
`ServiceSnapshot.scripts`/`consents`, and `HealthStatus.scripts`. Timers are
listed and cancelled through project units; integration tests now start project
bundles instead of individual scripts.

HTTP webhook definitions now resolve the project's bound instance, register the
hook on that instance, publish inbound deliveries with its `connectionId`, and
write status back to the instance record.

The CLI keeps `ballast plan <path>` and `ballast run <path>` for a project
directory. Single-file `ballast plan file.ts` / `ballast run file.ts` remain as
a convenience for examples and one-off scripts; they do not create service-side
script state and are not a second project model.

## Migration and reset

This round does not add a compatibility layer.

- Pre-0009 connection records are loaded as instances. Their ids may still look
  like `obs/main`, but no project is bound to them.
- Project state itself already follows 0008's clean reset. There is no
  migration from per-script state.
- Existing projects will show unbound requirements after upgrade. If exactly
  one instance of an integration exists, it is proposed; otherwise the user
  chooses one in the UI or by calling `SetProjectBinding`.
- Deleting `.ballast/bindings.json` resets bindings for that project. The
  service then proposes the sole matching instance, if any, on the next check
  or start.
- Because bindings store opaque ids, deleting and recreating an instance
  breaks old bindings. The old id is gone; the project reports the requirement
  as unbound and must be rebound. This is intentional: ids are not names.

## Verification

Covered by:

- `apps/agent/test/connections-instances.test.ts` — instances without
  projects, unbound start rejection, proposal confirmation, per-instance event
  routing, rebinding restart, delete refusal and string-array param options
  against the bound instance;
- `apps/agent/test/project-create.test.ts` — scaffold, check/plan errors and
  health consent counts;
- `packages/agent-protocol/test/rpc.test.ts` — `boundBy` and CRUD surface;
- `packages/e2e/test/project.test.ts` — real service creates a connection
  instance, binds the slot, starts one project worker and receives a
  unit-filtered log;
- `apps/desktop/e2e/desktop.spec.ts` — installs the real service, configures a
  fake instance, starts a scaffolded project and observes a worker tick;
- `apps/agent/test/mock-sources.test.ts` — plans every mock source and the
  scaffold through the same project `tsconfig.json` the editor uses.
