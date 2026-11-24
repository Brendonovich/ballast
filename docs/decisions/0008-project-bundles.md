# 0008 — Project bundles: one project, one bundle, named units

*Status: W1 (core units), W2 (planner project bundles), W4 (project runtime),
the protocol half of W5, and W6 (integration cutover) implemented · 2026-11-23 ·
effect `4.0.6`*

## Context

Ballast currently treats a TypeScript file as a **script**: every file is
planned, started, stopped and versioned independently. That made the Phase 0
spike small, but it is the wrong unit for real projects:

- a project is one thing the user enables; one worker, one consent decision and
  one manifest describe it;
- units inside a project (a subscription, a timer, a workflow, a param, a
  run-loop) need names, source links and independent visibility, but they
  should not be independently uploaded or hot-swapped;
- a workflow body needs to close over values created in init (an OBS
  connection, a request client), so the outer project bundle is the natural
  lifetime boundary.

This decision replaces the script unit with a **project bundle**:

- one entry file, `ballast.ts` at the project root by default;
- one manifest, one worker, one consent/diff per project;
- modules export Effects and the root composes them;
- units are named declarations inside that bundle.

The document also records the implementation plan and the state migration.

## 1. Project bundle shape

### Entry

A project is a folder containing:

~~~text
my-project/
  ballast.ts          # default entry; exactly one bundle
  src/
    a.ts
    b.ts
  .ballast/           # agent state (not source)
  package.json        # optional
~~~

`ballast.ts` must default-export an Effect:

~~~ts
// ballast.ts
import { Effect } from "effect";
import { alerts } from "./src/a.ts";
import { chat } from "./src/b.ts";

export default Effect.all(
  [
    alerts,
    chat,
  ],
  { discard: true },
);
~~~

There is no wrapper type and no second entry. A module exports an Effect; the
root composes them.

### Entry override

**Decision: fixed `ballast.ts` by default, optional
`package.json#ballast.entry`.**

~~~json
{
  "ballast": {
    "entry": "src/main.ts"
  }
}
~~~

- Only one entry is allowed. The field is a project-relative path, not an
  absolute path, and must stay inside the project root.
- If the field is absent, the agent uses `ballast.ts`.
- If the field is present but invalid, planning fails with a project error;
  there is no fallback to `ballast.ts`.
- No file-upload or multiple-entry API. The agent reads the project folder.

This keeps the default obvious while allowing projects that already have a
different main file. A package.json field is chosen over a separate
`ballast.json` so a project has one metadata file.

### Modules and imports

Scripts may import `effect`, `@ballast/*`, and relative project files. The
bundler resolves relative modules and the workspace/agent dependencies; the
entry and all imported modules are one rolldown bundle.

## 2. Units

A unit is a named declaration in the bundle. Units are the identity for
manifest diffs, logs, events, timers, workflow runs, params and state.

| Kind | Declaration | Name source | Durable? |
|---|---|---|---|
| Subscription | `Topic.subscribe(name, connection, handler, options?)` | explicit name (required after cutover) | Event delivery is at-least-once by the bus; handlers are not durable |
| Workflow | `Workflow.make(name, spec, body)` | explicit name | Yes: engine store |
| Timer | `Ballast.Timer.subscribe(name, schema, handler, options?)` | explicit name | Yes: timer store |
| Param | `Ballast.Param.string(key, ...)` | explicit key | No; project setting |
| Run loop | `Ballast.run(name, effect)` | explicit name | **No**; explicitly non-durable |

Rules:

- Names are unique **per kind per project**. A timer named `cooldown` and a
  workflow named `cooldown` are different namespaces. Duplicate names of the
  same kind fail planning.
- Names must be non-empty and stable across reloads. Renaming a unit is a
  removal plus an addition in the diff.
- Every unit records a source link:
  ~~~
  source: { file: "src/a.ts", line: 14, column: 17 }
  ~~~
  `file` is project-relative, line is 1-based and column is 1-based.
- Params are project-level settings, keyed by the param key. A param read by a
  workflow body is the same project setting as one read by a handler. Booleans,
  enums and string lists always have a runtime value, so they record their
  implicit default (false, the first enum value, []) in the manifest and are
  not reported as required. A string or number without a default remains
  required because an empty input is not a usable value.
- `Ballast.run` loops must be named. They are for processes that live only
  while the bundle worker lives; anything that must survive a restart or a
  sleep belongs in a workflow activity. This distinction is documented in the
  API and checked by review, not by types.

### Source links

At plan time every declaration captures the call site with a stack capture.
The plan bundle is generated with a source map; the planner maps the raw
bundle file/line/column through that map to the original project-relative
file.

The prototype proves this for named subscriptions:

- core `captureSource` (`packages/core/src/source.ts`) captures a raw frame;
- `Topic.subscribeNamed` passes it to the manifest recorder;
- planner emits a source map on the plan bundle
  (`packages/planner/src/bundle.ts`), reads it with `source-map-js`, and maps
  the location in `packages/planner/src/source-map.ts`;
- the fixture `packages/planner/test/fixtures/project/ballast.ts` imports
  `src/a.ts`, where the units are declared. The planned manifest points at
  `src/a.ts` for the param (line 15), timer (line 21), run (line 28),
  workflow (line 35) and subscription (line 48).

The same hook will be applied to params, timers, workflows and run loops. A
source link is **not** captured for unnamed legacy subscriptions, so existing
manifests and integrations are unchanged during the cutover.

### Named-subscribe cutover

The final API is:

~~~ts
yield* Tick.subscribe("tick-handler", connection, handler);
~~~

W6 is implemented: the legacy unnamed form is gone.

~~~ts
Tick.subscribe("tick-handler", connection, handler, options?)
~~~

All 8 integration packages that declare topics (`fake`, `http`, `keyboard`,
`midi`, `obs`, `twitch`, `vtube-studio`, `websocket`), the examples, and
the call sites in tests/apps were cut over. The planner rejects duplicate
subscription names and requires a name for every subscription.

`Topic.subscribe` gains a leading name; direct integration calls listed in
step 2 are the compilation impact. `Topic` declarations themselves do not
change.

## 3. Manifest

The project manifest replaces the script manifest. One project has one
manifest:

~~~json
{
  "project": { "id": "proj_main", "entry": "ballast.ts" },
  "params": [],
  "connections": [
    { "integration": "fake", "slot": "main", "location": "local" }
  ],
  "topics": [
    {
      "name": "named-tick",
      "integration": "fake",
      "slot": "main",
      "topic": "fake/tick",
      "scopes": ["fake:read"],
      "onStale": "drop",
      "maxAgeMs": 60000,
      "source": { "file": "src/a.ts", "line": 14, "column": 17 }
    }
  ],
  "requests": [],
  "timers": [],
  "workflows": [],
  "runs": [
    {
      "name": "supervisor",
      "source": { "file": "ballast.ts", "line": 8, "column": 12 }
    }
  ],
  "unresolved": []
}
~~~

Changes from the script manifest:

- `script.id` becomes `project.id` plus `project.entry`.
- `topics`, `timers`, `workflows` and `runs` gain `name` and `source`.
- `params` keep `key` and gain `source`; values stay project-level.
- Connections/requests/scopes remain project-level. There is no per-script
  consent.
- `runs` is additive; run loops are not durable and do not appear in timer or
  workflow stores.

The diff is by unit kind and name:

~~~ts
interface UnitChange {
  kind: "topic" | "timer" | "workflow" | "param" | "run";
  name: string;
  change: "added" | "removed" | "changed";
  before?: { source?: SourceLocation; schema?: unknown };
  after?: { source?: SourceLocation; schema?: unknown };
}
~~~

`requiresConsent` is true only for a **new scope** or a **new connection
slot**. A changed timer/workflow/param payload schema, a changed source line or
a changed run-loop name does not require consent; it requires a whole-bundle
restart. This keeps the consent model about external permissions.

## 4. Reload, failure and lifecycle

The project bundle is the reload unit. Any file change under the project
(entry, imported module, package.json entry, tsconfig if used) triggers:

1. plan the whole project in a throwaway plan worker;
2. run project typecheck (below);
3. diff units by `(kind, name)` and permissions;
4. if new scopes/connections: create one project-level consent request;
5. otherwise start a new bundle worker, register the new units and streams;
6. cut over event delivery to the new worker immediately;
7. give the old worker a grace period for in-flight handlers, then close it.

A failed bundle, typecheck or plan **keeps the previous worker running** and
records an error with file/line. The UI says:

> Running previous version. Latest change failed: src/a.ts:14:17 — …

There is no per-file/per-unit hot swap and no file-upload API.

### Typecheck during planning

Planning must run `tsgo` before accepting a bundle. Decision:

- if the project has a `tsconfig.json`, run `tsgo --noEmit -p
  <project>/tsconfig.json` directly, so the gate and the editor see the same
  config;
- otherwise generate `.ballast/tsconfig.generated.json` with the agent's base
  config, the project's files and `@ballast/*` types;
- scaffolds write an editor-ready `tsconfig.json` whose `paths` point at
  `<dataDir>/types/current`; that stable symlink resolves `@ballast/*`,
  `effect` and `@types/node` from the service's own bundle, so a project
  outside the repo works in an editor and in the gate without installing
  packages;
- ensure (and, on a service update, repoint) `types/current` at service
  startup and before every check or plan, so projects created by an older
  service still resolve types;
- run it from the agent stage, cache by the hash of project source files, the
  resolved tsconfig bytes and the real paths its type roots resolve to (so a
  repointed `types/current` is a cache miss), and reuse the result when
  nothing changed; never cache environment failures such as a missing
  `@types/node` (TS2688), because they can be fixed without changing a
  project source byte;
- a typecheck failure is a plan failure: keep the old worker, surface the
  `tsgo` diagnostic (file/line/message) in the project error.

Cost: `tsgo` is fast but not free (roughly sub-second to a few seconds for a
small project; first run includes project loading). It is deliberately on the
save path for a whole project because a failed bundle must not replace a
running one. The plan worker can run typecheck and bundle in parallel only if
the typecheck result gates the cutover, not the planning itself.

### Runtime reads and live params

Init declares; handlers and runs read. That rule is enforced in the type system,
not only at runtime:

- `Ballast.Runtime` is a marker service. Subscription handlers, `Ballast.run`
  bodies, timer handlers and workflow bodies (and activities) accept effects
  that require it and provide it at their boundary. Declarations do not require
  it.
- `Param<A>` is `Effect<A, never, Ballast.Runtime>`. Request clients (OBS and
  the other generated/local clients, `account.helix` calls) and timer
  `after`/`cancel` and workflow `execute`/`resolve` carry the same requirement.
  `Connection`, `Account`, `helix(name)`, `Param.*`, `subscribe`,
  `Timer.subscribe`, `Workflow.make` and `run` itself do not.
- The typecheck gate writes `.ballast/entry-check.ts` and a check config that
  extends the project/generated config, and asserts the entry's requirements
  contain no `Ballast.Runtime`. A failure is reported at the entry with
  "This reads a runtime value (param/request/timer) during init. Move it inside
  a subscribe handler, Ballast.run, or a timer/workflow body". If the project
  writes `export default ... satisfies Ballast.Project`, the editor reports the
  same violation at the offending `satisfies` line; the gate keeps a runtime
  guard that names the declaration for untyped/hand-written entries.
- A param value changed while the project runs is pushed to the worker's
  `Settings` Ref over the existing worker channel. The next `yield* param`
  read in an in-flight handler or run loop sees the new value. There is no
  restart and no generation change. Option-backed enum/strings validation still
  applies; changing a binding still restarts; a stopped project only saves.

### Enable/disable

Enable/disable is **per project only**. There is no per-unit enable. Stopping a
project stops its worker and all units; pending timers/workflow executions are
kept in the project stores and follow their policies on the next start. A
project-level consent gates the whole new bundle.

## 5. State migration

Current per-script state moves to project scope:

| Current | New |
|---|---|
| `.ballast/settings.json` → `scripts[scriptId].enabled` | `.ballast/settings.json` → `enabled` at project root |
| `.ballast/settings.json` → `scripts[scriptId].params` | `.ballast/settings.json` → `params` keyed by param key |
| `.ballast/applied/<scriptId>.json` | `.ballast/applied.json` (one project manifest) |
| `.ballast/timers.json` per script | `.ballast/timers.json` per project, entries keep unit name + key; add project id |
| `.ballast/workflows/<scriptId>.json` | `.ballast/workflows.json` or one store per project |
| logs `(projectId, scriptId)` | `(projectId, unitKind, unitName)` |
| state store per script | project state keyed by unit name |

Migration at project discovery:

1. If new project files exist, use them.
2. Otherwise read the old per-script settings/applied/timer/workflow files.
3. Merge script params into the project params map; a collision between two
   scripts' params is an explicit error (do not guess).
4. Merge applied manifests into one unit manifest; duplicate unit names across
   old scripts are a migration error with both source scripts listed.
5. Merge timers/workflows keyed by unit name; keep the old execution ids.
6. Write new files atomically and leave the old files untouched for one
   release (or move them under `.ballast/legacy/`).
7. If migration fails, do not start the project; show the conflict.

Backwards compatibility is not a product requirement, but migration must not
silently lose user state.

**Implementation choice:** the service performs a clean reset for the first
project-bundle cutover. It reads/writes only `.ballast/settings.json` with
`{ enabled, params }` and `.ballast/applied.json`; old per-script settings,
applied files and timer entries are ignored rather than merged. This avoids a
silent collision between two scripts' params or unit names while the UI is
still moving to the project surface.

## 6. Agent protocol

The protocol becomes project/unit-oriented. Additive/renamed at the next
apiVersion bump:

- `ScriptSummary` → `ProjectSummary` with `units` grouped by kind:
  ~~~ts
  interface UnitSummary {
    kind: "topic" | "timer" | "workflow" | "param" | "run";
    name: string;
    title?: string;
    source?: { file: string; line: number; column: number };
    status?: "active" | "waiting" | "error";
  }
  interface ProjectUnitsView {
    projectId: string;
    entry: string;
    enabled: boolean;
    status: "stopped" | "running" | "needs-consent" | "error";
    units: UnitSummary[];
    manifest: ProjectManifestView;
    pendingConsent?: ConsentRequest;
  }
  ~~~
- Source RPCs: `GetProjectSource` (`GetScriptSource` replacement) returns the
  entry file; `ListProjectFiles` and `ReadProjectFile({ path })` provide the
  read-only file tree/source pane. There is no file write/upload RPC.
- Logs/events: filters become `{ projectId?, unitKind?, unitName? }`; records
  carry `unitKind` and `unitName` instead of `scriptId`.
- Mutations: `CreateProject` (scaffold), `StartProject`, `StopProject`,
  `RestartProject`, `PlanProject`, `CheckProject` (non-applying), `SetProjectParam`,
  `ApproveProjectConsent`, `RejectProjectConsent`; `ListConsents` is project-level.
  The projects base directory is `BALLAST_PROJECTS_DIR` (default
  `<home>/ballast-projects`).
- Workflow/timer surfaces: executions/timers are listed by project and unit
  name, not script id.
- Migration/versioning: rename RPCs or add new ones; bump `apiVersion` when
  the old `ScriptSummary` semantics disappear.

## 7. UI

Project view replaces the script list/detail split:

- one project header with entry path, enabled/status, Plan/Restart/Stop and
  consent banner;
- units grouped by kind (Subscriptions, Timers, Workflows, Params, Run loops);
  each row shows name, source link, status and kind-specific detail (topic,
  next timer, workflow executions, param value);
- clicking a source link opens the project file tree at that file and jumps to
  the line/column;
- Source pane browses project files read-only; the entry file is highlighted;
- Logs filter by unit kind/name and show the unit tag from fiber annotations;
- Params form is project-level, not per script;
- Workflow executions and timers appear as unit detail, not separate script
  pages;
- no file upload, no multiple entries, no per-unit start/stop.

## 8. Service shape

`ScriptManager` becomes `ProjectRuntime` (or a project runtime inside
`ProjectManager`):

- one bundle worker per project, one generation per whole-bundle reload;
- plan whole project → unit-level diff → consent → new worker → cutover;
- old worker grace period: stop new event delivery to it, let in-flight
  handlers finish up to a bounded grace (e.g. 30s), then close; log which
  handlers were still running if the grace expires;
- `ProjectStore` owns project settings/applied manifest/timers/workflows;
- `ConnectionManager` continues to reference-count connections from running
  project manifests;
- workflow/timer runs are tagged with project id + unit name; the service
  starts/stop them with the project runtime;
- failure of typecheck/bundle/plan keeps the old worker and publishes a
  project error with source location.

## 9. Implementation plan (parallel workstreams)

| # | Workstream | Scope | Depends on |
|---|---|---|---|
| W1 | Core unit API and manifest | `SourceLocation` schema, named subscription API, `Ballast.run(name, ...)`, workflow/timer source, unit name validation, manifest/project shape | none |
| W2 | Planner project bundles | entry resolution, whole-project bundle, source maps, `tsgo` gate, project manifest, unit diff/name checks | W1 |
| W3 | Workflow API v2 | one-call `Workflow.make`, handle `resolve`, required-schema activity sugar, tests/examples | independent of W2 except manifest source hook |
| W4 | Service runtime | `ProjectRuntime`, whole-bundle workers, grace-period cutover, project stores, migration | **wait for the timer service work in apps/agent to land** |
| W5 | Protocol + UI | project/unit views, source tree/read, unit logs/events, project params, workflow/timer UI | W4 shape, can mock before |
| W6 | Integration cutover | migrate 8 integration packages and examples to named `subscribe`; remove `subscribeNamed` | W1 |
| W7 | Verification/migration | multi-file fixture, typecheck/bundle failure tests, migration fixtures, end-to-end real project | W1–W6 |

Ordering:

1. W1 + W3 in parallel (this round);
2. W2 on top of W1;
3. W6 as soon as W1's named API is stable;
4. W4 only after the timer service owner finishes in `apps/agent`;
5. W5 can start against a protocol mock and connect after W4;
6. W7 continuously, with a final whole-project E2E.

Implemented this round:

- W1: named `subscribe`, named `Ballast.run`, source capture for all unit
  kinds, unit annotations, duplicate-name planning errors with both sources,
  additive `runs` manifest field.
- W2: entry resolution (`ballast.ts` / `package.json#ballast.entry`),
  whole-project planning, source-map mapping, tsgo gate with generated
  tsconfig + cache, unit diff.
- W6: all 8 integrations, examples, tests and app call sites cut over.
- W4/W5 remain service/UI work; only call-site edits were made in apps, and
  `packages/agent-protocol/src/mock-sources.ts` was changed only at its
  subscribe/run call sites.

## 10. Limits and open questions

- Source mapping is proven for a named subscription. Line/column stability
  under minification is not relevant (plans do not minify); column is
  generator-specific and should be treated as a jump target.
- Stack capture cannot find a declaration created inside a dynamically
  generated function with no source; planning should fail rather than invent a
  location. Prototype leaves source optional for unnamed/legacy units.
- Typecheck with a project tsconfig can be slow or use a different TS version;
  generated config is the fallback. Decide whether `tsgo` is mandatory on
  every save or debounced; recommendation is debounce saves until the bundle
  is quiet.
- One worker per project changes resource usage for large projects. Measure
  before adding worker pooling; do not reintroduce per-unit workers.
- Workflow activities remain inline and are not in the project manifest; their
  runtime journal is the verification source. The project manifest lists only
  workflows/sleeps? Sleeps are not listed.
- Run loops are explicitly non-durable. A run loop that needs to survive a
  restart must become a workflow or be replaced by timer events.
- Migration of old per-script timers/workflows needs a one-time test with real
  files; do not ship migration without it.

## 11. Prototype results

Core/planner additions:

- `packages/core/src/source.ts` — stack capture.
- `packages/core/src/manifest.ts` — `SourceLocation`, optional `source` on
  units, optional `name` on topics, `runs` planned.
- `packages/core/src/topic.ts` — `subscribeNamed(name, ...)`; legacy
  `subscribe` unchanged.
- `packages/planner/src/bundle.ts` — source map generation.
- `packages/planner/src/source-map.ts` — source-map-js mapping and
  project-relative normalization.
- `packages/planner/src/plan.ts` — `projectRoot` option, duplicate name
  validation.
- `packages/planner/test/fixtures/project/{ballast.ts,src/a.ts}` — multi-file
  fixture.
- `packages/planner/test/plan.test.ts` — asserts `src/a.ts:14:17` for a
  subscription declared in the imported module.

Planned manifest for the 2-file fixture:

~~~json
{
  "script": { "id": "test/fixtures/project/ballast" },
  "params": [],
  "connections": [
    { "integration": "fake", "slot": "main", "location": "local" }
  ],
  "topics": [
    {
      "integration": "fake",
      "slot": "main",
      "topic": "fake/tick",
      "name": "named-tick",
      "source": { "file": "src/a.ts", "line": 48, "column": 17 },
      "scopes": ["fake:read"],
      "onStale": "drop",
      "maxAgeMs": 60000
    }
  ],
  "requests": [],
  "unresolved": [],
  "timers": [
    {
      "name": "heartbeat",
      "source": { "file": "src/a.ts", "line": 21, "column": 12 },
      "onStale": "deliver",
      "maxAgeMs": 604800000
    }
  ],
  "workflows": [
    {
      "name": "fixture-workflow",
      "source": { "file": "src/a.ts", "line": 35, "column": 12 }
    }
  ],
  "runs": [
    {
      "name": "ticker",
      "source": { "file": "src/a.ts", "line": 28, "column": 12 }
    }
  ]
}
~~~

The `script` key is retained only during the transitional prototype; the
project bundle cutover replaces it with `project: { id, entry }` and adds
`runs`.

## 12. Verification

~~~
pnpm --filter @ballast/workflow typecheck
pnpm --filter @ballast/workflow test       # 6 passed
pnpm --filter @ballast/core typecheck
pnpm --filter @ballast/core test           # 15 passed
pnpm --filter @ballast/planner typecheck
pnpm --filter @ballast/planner test        # 21 passed (source map, typecheck, diff)
pnpm --filter @ballast/examples typecheck
pnpm typecheck                             # clean
pnpm test                                  # all workspace tests passed
fnm exec --using=24.22.2 pnpm --filter @ballast/e2e test  # 2 passed, 1 skipped
~~~

The workflow one-call API sample is in `examples/redeem-takeover.ts`;
`ballast plan` shows the workflow declaration but no activities, and the
subscription fixture test proves the source-map mapping.
