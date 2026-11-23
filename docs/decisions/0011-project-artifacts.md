# 0011 — Project artifacts: custom project UI over typed RPC

*Status: accepted; core + planner implementation and the isolated spike landed
(2026-11-24); service gateway, tokens and persistence remain with the service
agent · effect `4.0.6`*

## Context

Decision 0008 made the project the unit of work: one `ballast.ts` bundle, one
worker, one manifest, named units with source links. Decision 0009 separated
connection instances from project-local slots. The service already has one
project worker per generation, unit-filtered logs/events, params, timers and
project-scoped settings under `.ballast/`.

The next product step is **Project Artifacts**: custom UI written by the user
and their agent, opened inside the project, that can:

- read project metadata (units, status, params, timers, logs, workflows);
- call actions declared by the project (for example “reset counters”);
- query project state and subscribe to live streams (a dashboard counter and
  event log is the canonical example).

The UI must not receive the service token, connection secrets or access to
another project. It must be safe to put in OBS as a Browser Source.

This round is design and an isolated spike only. The service agent is changing
core/agent for `Ballast.Runtime`, live params and connection bindings; the UI
agent is moving to one project per window. No core, planner, app or MCP code was
changed for this decision.

## Decisions (accepted 2026-11-23)

The user accepted the recommendations on the open questions:

1. **SolidJS template.** Artifacts get a blessed SolidJS template and scaffold.
   Plain TS/TSX + DOM entries remain supported; the template is a convenience,
   not a required framework.
2. **Writable artifacts in v1.** Action-scoped artifacts may call `SetParam`
   and `CancelTimer`. Reads and the custom project API remain available to
   read-only artifacts.
3. **URL token for OBS.** OBS Browser Source uses a stable URL carrying a
   scoped, revocable token. Rotation replaces the URL.
4. **Action URL confirmation.** Creating an action-capable public URL, or
   widening an existing URL from read to action, requires explicit user
   confirmation. Read-only URLs do not.
5. **Store v1.** Ship `Ballast.Store.counter` only. KV/collections wait.
6. **One API group.** One project API group for v1.
7. **Whole API access.** Every artifact may call every procedure in the
   project API; the token scope decides read vs action.
8. **Event history replaces Store.log.** Every subscription records inbound
   events automatically (default 1000 entries / 7 days). Topics can set their
   own default or disable it; a subscription option overrides it. `query` and
   `watch` are typed by the topic schema, keyed by subscription name, and
   preserve old-schema rows as explicit legacy entries. Keyboard topics are off
   by default; high-rate OBS/MIDI topics are off too.

## 1. Declaration and bundling

### Artifact unit

An artifact is a named unit declared in init, like a timer or run loop:

```ts
// ballast.ts
import { Effect } from "effect";
import * as Ballast from "@ballast/core";

export default Effect.gen(function* () {
  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    entry: "./artifacts/dashboard/main.tsx",
  });

  yield* Ballast.Api.serve(DashboardApi, handlers);

  // normal project units...
});
```

Rules:

- `name` is unique per project and stable across reloads;
- `entry` is project-relative, must stay inside the project, and must exist;
- the artifact module is not imported by the worker bundle. It is a second
  browser bundle over the same source tree;
- an artifact declaration records a source link and a fingerprint in the
  manifest. Changing only the artifact code does not require a new worker
  generation; changing `src/api.ts` or a shared schema does.
- the artifact entry is included in the plan/typecheck gate. The planner builds
  it only after typecheck succeeds.

### UI technology

**Recommendation: framework-agnostic TS/TSX + DOM for v1.** The artifact entry
exports a mount function:

```tsx
// artifacts/dashboard/main.tsx
import { createArtifact } from "@ballast/artifact";
import { DashboardApi } from "../../src/api.ts";

export default createArtifact(DashboardApi, (client, root) => {
  // plain DOM, or the user's own small render helper
  const count = document.createElement("div");
  root.append(count);
  return () => count.remove();
});
```

Why not a blessed SolidJS template first:

- the app happens to use Solid, but an artifact is user/agent-authored code and
  should not inherit the app's framework or component model;
- a DOM-first contract keeps the bundle small, the API stable and the template
  replaceable. TSX is still supported by the bundler, so a project can use
  Solid/React/Preact later if it brings its own runtime;
- if agents consistently write better Solid code, add an optional
  `@ballast/artifact-solid` template later without changing the transport or
  manifest.

The artifact package is imported only by artifact code. It provides:

- `createArtifact(api, mount)` with lifecycle and token-aware client setup;
- typed metadata client methods;
- `useStream`/`subscribe` helpers over Effect RPC streams;
- no access to the service or connection secrets.

### Planner and bundling

The planner's project bundle step gains a second rolldown pass per artifact:

- input: the artifact entry;
- platform: `browser`, format `esm`, no Node built-ins;
- resolver: the same project/workspace resolver used by the worker bundle;
- output: `.ballast/artifacts/<artifact>/<contentHash>/` with `index.html`,
  `main.js` and source maps (or a single JS + generated shell);
- errors carry original `file:line:column` via the source map, exactly like
  plan/bundle errors today.

Typecheck has two configs:

1. the project `tsconfig.json` or generated worker config (no DOM, no
   artifact-only files);
2. a generated artifact config that extends the project config, adds
   `lib: ["ES2024", "DOM", "DOM.Iterable"]` and includes every artifact entry
   plus its imports.

If a project already has a tsconfig, the artifact config extends it; a project
that does not gets the same generated dual config the planner already writes.
`CheckProject` returns diagnostics from both passes with a kind
(`worker`/`artifact`) so an agent can fix the right file.

### Hot reload

- file changes still trigger the existing project sync and plan;
- if only artifact files changed, rebuild the artifact, bump its content hash,
  publish `artifact-changed`, and reload the artifact view. The worker keeps
  its generation.
- if the shared API module, a schema, or any worker file changed, use the
  existing whole-generation cutover.
- the artifact host serves immutable hashed assets, so an OBS Browser Source can
  reload without a stale module graph.

## 2. Project API: actions, queries and streams

### Recommendation: Option A — one Effect `RpcGroup` in a shared module

```ts
// src/api.ts — imported by ballast.ts and the artifact
import { Rpc, RpcGroup, Schema } from "effect";
import { action } from "@ballast/artifact/protocol";

export const DashboardApi = RpcGroup.make(
  Rpc.make("Snapshot", {
    success: Schema.Struct({
      count: Schema.Number,
      startedAt: Schema.Number,
    }),
  }),
  action(Rpc.make("Increment", {
    payload: { by: Schema.Number },
    success: Schema.Number,
  })),
  Rpc.make("Events", {
    stream: true,
    success: Schema.Struct({
      count: Schema.Number,
      at: Schema.Number,
    }),
  }),
);
```

```ts
// ballast.ts
import { Effect, Ref, Stream } from "effect";
import * as Ballast from "@ballast/core";
import { DashboardApi } from "./src/api.ts";

export default Effect.gen(function* () {
  const count = yield* Ref.make(0);

  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    entry: "./artifacts/dashboard/main.tsx",
  });

  yield* Ballast.Api.serve(DashboardApi, {
    Snapshot: () =>
      Effect.map(Ref.get(count), (value) => ({ count: value, startedAt: Date.now() })),
    Increment: ({ by }) => Ref.updateAndGet(count, (value) => value + by),
    Events: () =>
      Stream.tick("500 millis").pipe(
        Stream.mapEffect(() =>
          Effect.map(Ref.get(count), (value) => ({ count: value, at: Date.now() })),
        ),
      ),
  });
});
```

Artifact side:

```tsx
import { createArtifact } from "@ballast/artifact";
import { Stream } from "effect";
import { DashboardApi } from "../../src/api.ts";

export default createArtifact(DashboardApi, (client, root) => {
  const count = document.createElement("strong");
  const log = document.createElement("ul");
  root.append(count, log);

  void Effect.runPromise(client.Snapshot()).then((value) => {
    count.textContent = String(value.count);
  });

  void Effect.runPromise(
    client.Events().pipe(
      Stream.take(20),
      Stream.runForEach((event) => {
        const item = document.createElement("li");
        item.textContent = String(event.count);
        log.append(item);
        return Effect.void;
      }),
    ),
  );

  return () => root.replaceChildren();
});
```

Why Option A:

- one typed contract, checked by tsgo for both sides;
- procedures are schema-declared; payload, success, error and stream element
  schemas are all recoverable for the manifest/catalog;
- Effect RPC supplies streaming, interrupts, defects and serialization;
- one manifest surface instead of many pseudo-units;
- the artifact imports the same module as the worker, so a rename or schema
  change is a compile error on both sides, not a runtime mismatch.

Option B (`Ballast.Action` / `Ballast.Query` / streaming units) was rejected
for v1: it multiplies unit names and diffs, has no shared client contract, and
reimplements what `RpcGroup` already gives. It remains a possible future
convenience layer that generates an RpcGroup.

### Handler context

Handlers execute in the project worker, never in init:

- `Ballast.Runtime` (the in-flight typed runtime service) is available;
- params can be read lazily, requests can be called, timers/workflows can be
  scheduled;
- an API handler is the same kind of execution context as a topic/timer
  handler, with a unit annotation `api:<procedure>` for logs and spans;
- handlers must not block the worker; long work belongs in `Ballast.run` or a
  timer/workflow.

### Manifest

```json
{
  "api": {
    "name": "DashboardApi",
    "source": { "file": "src/api.ts", "line": 4, "column": 20 },
    "procedures": [
      {
        "name": "Snapshot",
        "kind": "query",
        "successSchema": { "...": "JSON Schema" },
        "fingerprint": "sha256:..."
      },
      {
        "name": "Increment",
        "kind": "action",
        "payloadSchema": { "...": "JSON Schema" },
        "successSchema": { "type": "number" },
        "fingerprint": "sha256:..."
      },
      {
        "name": "Events",
        "kind": "stream",
        "successSchema": { "...": "JSON Schema" },
        "fingerprint": "sha256:..."
      }
    ]
  }
}
```

The planner derives `kind` from the Rpc success schema: stream schema =
`stream`, otherwise `query`/`action` by annotation. Action vs query is
declared explicitly with an RPC annotation (for example
`action(Rpc.make("Increment", ...))` from `@ballast/artifact/protocol`, or
`Ballast.Api.action(...)` when the module already imports core) so a UI cannot
infer write rights from a name. The default is read-only query.

Streaming uses Effect RPC `stream: true`. The service proxies chunks to the
artifact WebSocket. Backpressure is the RPC client's ack/queue path; the spike
proved that chunks arrive through a WebSocket proxy without buffering the whole
stream.

## 3. Built-in metadata API

Every artifact gets a service-handled, read-mostly API in addition to the
project's custom API:

```ts
ArtifactMetadata {
  Project(): {
    id: string;
    name: string;
    entry: string;
    status: "stopped" | "running" | "needs-consent" | "error";
    generation: number;
    startedAt?: number;
    lastError?: { message: string; file?: string; line?: number; column?: number };
  }

  Units(): ReadonlyArray<{
    kind: "topic" | "timer" | "workflow" | "param" | "run" | "artifact";
    name: string;
    status?: string;
    source?: { file: string; line: number; column: number };
  }>

  Params(): ReadonlyArray<{
    key: string;
    type: "string" | "number" | "boolean" | "enum" | "strings";
    title?: string;
    description?: string;
    value: unknown;
    default?: unknown;
    options?: ReadonlyArray<string>;
    optionsSource?: { integration: string; slot: string; source: string };
    writable: boolean;
  }>

  Logs(input?: { unit?: string; kind?: string; limit?: number }): Stream<LogLine>
  Events(input?: { unit?: string; kind?: string }): Stream<ProjectEvent>
  Timers(): ReadonlyArray<TimerSummary>
  Workflows(): ReadonlyArray<WorkflowRunSummary>
}
```

Metadata is read-only by default. Writable methods are an explicit allowlist:

- `SetParam({ key, value })` — only if the token has `action` and the param is
  not marked secret; the service validates the same type/options rules as the
  UI and live params, then updates the worker;
- `CancelTimer({ name, key })` — action-scoped, audited;
- no connection creation/update/delete, no bindings, no service shutdown, no
  raw file writes, no secrets.

The service handles metadata without a worker round trip. Custom API calls are
proxied to the project worker. Both share the same authenticated artifact
session, so `Units()` and a custom `Snapshot()` see the same project id.

## 4. Transport and security

### Origin and shell

**Recommendation: a dedicated artifact origin on a separate localhost port**,
not the service UI origin. The app's origin carries an HttpOnly service cookie;
artifact code must never be same-origin with it.

- artifact host: `http://127.0.0.1:<artifact-port>`
- service UI: current service port/origin
- artifact pages are served inside `<iframe sandbox="allow-scripts">` in the
  project window. No `allow-same-origin`, no top navigation, no forms, no
  popups by default.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; connect-src ws://127.0.0.1:<port>;
  frame-ancestors http://127.0.0.1:<ui-port>` and
  `Referrer-Policy: no-referrer`.
- no service cookie, no service localStorage, no CORS to service RPC.
- artifacts cannot import Node, `fs`, `child_process`, or npm packages; the
  browser bundle rejects them at build time.

### Token

A per-project, per-artifact, revocable token:

```text
artifact token = 32 random bytes, stored as a hash
{ projectId, artifact, scopes: ["read"] | ["read","action"], createdAt, lastUsedAt, expiresAt? }
```

- never the service token or desktop bridge token;
- generated when the artifact is opened or when the user creates an OBS URL;
- scoped to one project and one artifact; `action` is separate from `read`;
- revocation is immediate (delete the hash; close existing sessions);
- the UI shows “rotate token” and “revoke”;
- tokens are logged only as fingerprints, never as plaintext.

**URL form for OBS:** `http://127.0.0.1:<artifact-port>/a/<token>/index.html`
plus a read-only/action variant. Query-string tokens are the pragmatic choice
for a Browser Source because the user must copy one stable URL. Mitigations:
no-referrer, no external navigation, no service cookie, token is project-local,
and rotate/revoke invalidates the old URL. A first-message handshake is a
possible hardening step, but OBS reload behavior makes a URL token simpler.

**In-app view tokens:** `GetArtifactView` mints a short-lived, action-capable
embed token for the app's own iframe (the user is in the app, so their buttons
may call actions). The page keeps the token at `/a/<token>/index.html`;
`RenewArtifactView({ token })` extends that same token in place so the UI can
keep it alive without reloading the iframe and losing artifact UI state.
Several in-app views of the same project/artifact hold independent embed
tokens, each with its own expiry. Sockets stay connected while the token is
renewed; when an embed token expires the gateway closes its sockets with
`1008` and rejects new HTTP/WebSocket requests, so pages must renew before
`expiresAt`.

### Routing

```text
artifact page / asset
  -> artifact host checks token, serves immutable bundle

artifact WebSocket /rpc?token=...        (project API)
artifact WebSocket /metadata?token=...  (built-in metadata API)
  -> artifact gateway validates token + project + scopes

  metadata procedure?
    -> service metadata API (project state, params, logs, timers)

  custom API procedure?
    -> service resolves project worker generation
    -> RpcServer call / stream over the existing runtime session
    -> handler runs with Ballast.Runtime
```

- every request is bound to exactly one project; the gateway never lets a token
  address another project;
- custom API requests carry the procedure tag and are checked against the
  manifest's API fingerprint before dispatch;
- request/stream errors are opaque tagged errors plus a log entry; no worker
  stack traces or connection secrets are returned;
- action-scoped procedures require the action token; read-only tokens receive
  `Forbidden` without invoking the worker;
- the artifact cannot call `AgentRpcs`, `RuntimeRpcs` (host RPC), connection
  configuration, bindings, files, or the cloud.


### Worker contract (implemented in core)

The service gateway talks to the worker over a dedicated `MessagePort` passed
as `workerData.artifactPort`. The port carries Effect RPC frames directly:

```ts
interface ArtifactHostMessage {
  readonly kind: "artifact";
  readonly frame: FromClientEncoded; // Request | Interrupt | Eof | ...
}

interface ArtifactWorkerMessage {
  readonly kind: "artifact";
  readonly frame: FromServerEncoded; // Chunk | Exit | Defect
}
```

- core's `serveArtifactRpc(port, group, handlers)` runs an Effect
  `RpcServer` over the port; the service uses the matching
  `makeArtifactRpcClient(port, group)`;
- streaming is the normal Effect RPC `Chunk` frames;
- cancellation is the normal `Interrupt` frame;
- the worker registers the server only after init, from the `Api.serve`
  registration returned by `evaluateScript`.

### Store host contract (implemented in core)

`StoreHost` is counter-only:

```ts
StoreLoad({ name, kind: "counter", initial? }) -> unknown
StoreSetCounter({ name, value }) -> number
StoreIncrement({ name, by, initial }) -> number
```

Event history has its own runtime RPCs and worker-side host:

```ts
EventHistoryRecord({ name, fingerprint, event }) -> HistoryRecord
EventHistoryQuery({ name, limit, before? }) -> ReadonlyArray<HistoryRecord>

interface EventHistoryHostService {
  record(input): Effect<void>;
  query(input): Effect<ReadonlyArray<HistoryRecord>>;
  watch(name): Effect<PubSub<HistoryRecord>>;
}
```

The service persists counters under `.ballast/stores/` and history under
`.ballast/history/`. `serveRuntimeRpc` provides in-memory fallbacks so
`ballast run` works before the service implements storage. The core exports
the exact `RuntimeHostHandlers` methods, so the service agent can implement
them without a second protocol.

The action annotation is shared by string key: core's `Api.action` and
`@ballast/artifact/protocol.action` both annotate `Ballast/Api/Action`. The
gateway reads the manifest's `kind: "action"` and requires an action-scoped
token. A shared project `src/api.ts` imports the browser-safe helper from
`@ballast/artifact/protocol` so the shared module does not pull Node core into
the browser bundle.

### Solid template and client

`@ballast/artifact` is browser-safe and exports:

- `connect(group)` -> `{ api, metadata }` Effect RPC clients over the gateway;
- `createArtifact(group, mount)` lifecycle/scope helper;
- `@ballast/artifact/protocol` -> metadata RpcGroup + action annotation;
- `@ballast/artifact/solid` -> `createQuery` and `createStream` resources.

The reusable template is at `packages/artifact/template/`: `ballast.ts`,
`src/api.ts` and `artifacts/dashboard/main.tsx`. The service scaffold can copy
those files; the MCP scaffold can do the same.

## 5. Where artifacts open

The app is moving to one project per window, so the artifact shell is
project-scoped.

- **Units panel → Artifacts**: list declared artifacts with title, source,
  status and “open”. This is a unit section, not a separate top-level app.
- **Full-screen view**: project chrome hidden, artifact iframe fills the
  content area; Escape/back returns to the project.
- **Pop-out window**: a dedicated window with the same token/session; useful
  for a second monitor. Pop-outs close with the project window.
- **OBS Browser Source**: stable URL with a token. Provide two copy actions:
  - “Copy read-only URL” (dashboard/overlay with no action rights);
  - “Copy action URL” (buttons work; explicitly labeled as a capability).
  Show token rotation/revocation next to both.
- **Transparency**: artifact shell reads `?background=transparent` (or an
  artifact option) and sets a transparent root; OBS can layer the page over
  gameplay. Dashboard mode keeps the app’s dark background. The shell itself
  never paints an opaque body in overlay mode.
- **No service chrome** in the artifact iframe: no connection settings, no
  consent buttons, no file tree.

Multiple artifacts per project are allowed by the manifest; the first version
can ship one artifact per project in the UI and keep the API general.

## 6. Dashboard data: counters + automatic event history

Worker memory is lost on reload/restart, so dashboard state should not be a
closure. `Ballast.Store.counter` covers counters. Event logs use
**subscription history**, not a separate `Store.log` API.

```ts
const sceneSwitches = yield* Ballast.Store.counter("sceneSwitches", { initial: 0 });

const chat = yield* Twitch.ChatMessage.subscribe(
  "chat-scenes",
  broadcaster,
  handler,
  { history: { maxEntries: 1000, retention: "7 days" } },
);

// handlers, runs, Api.serve handlers (Ballast.Runtime only)
const recent = yield* chat.query({ limit: 50 });              // newest first
const older = yield* chat.query({
  limit: 50,
  before: recent.at(-1)?.cursor,
});
const live = chat.watch();                                   // Stream<HistoryEntry>

yield* sceneSwitches.increment(1);                           // number
```

History entries are explicit:

```ts
type HistoryEntry<A> =
  | { _tag: "Event"; cursor: string; receivedAt: number; event: A }
  | { _tag: "Legacy"; cursor: string; receivedAt: number; raw: unknown; fingerprint: string };
```

- **On by default.** Default policy: 1000 entries, 7 days.
- **Topic defaults:** a `Ballast.Topic({ history })` declaration can set a
  different policy or `false`. A subscription option overrides it.
- **Off by default for sensitive/high-rate topics:** all keyboard topics
  (`history: false`, keylogger risk), OBS high-volume events
  (`InputVolumeMeters`, `InputActiveStateChanged`, `InputShowStateChanged`,
  `SceneItemTransformChanged`) and MIDI `ControlChange`, `PitchBend`,
  `RawMessage`.
- **Manifest:** every subscription records `history` (resolved policy or
  `false`) and the topic `schemaFingerprint`.
- **Storage:** the service persists every inbound event before delivery, keyed
  by `project/subscription` and the schema fingerprint. Records survive worker
  reloads and service restarts under `.ballast/history/`.
- **Schema changes:** `query` decodes only records whose fingerprint matches
  the current topic schema. Mismatches are returned as `Legacy` raw rows when
  `includeLegacy: true`; the default filters them out.
- **Query paging:** newest first, bounded `limit`, `before: cursor` returns
  older rows.
- **Worker contract:** `EventHistoryRecord` and `EventHistoryQuery` on
  `RuntimeRpcs`; the worker-side `EventHistoryHost` also exposes a local
  `watch`. `ballast run` uses the in-memory host.

There is no handler-outcome or note API: durable notes/outcomes belong in
workflows. Counters are the only declared store unit:

```ts
interface StoreHostService {
  load(spec): Effect<unknown>;
  setCounter(name, value): Effect<number>;
  increment(name, by, initial): Effect<number>;
}
```

Storage lives under `.ballast/stores/<name>.json`. In-memory fallback is for
`ballast run` and tests.

## 7. Agent authoring

### Planner and `ballast_check`

- artifact units appear in ProjectDetail/units with source links;
- typecheck diagnostics include artifact files (DOM config) and worker files;
- browser bundle errors include original file/line;
- `CheckProject` returns artifact build status and a diff of artifact/API/store
  units;
- a failed artifact build keeps the previous artifact revision served while
  the worker can continue (or the whole project stays on the previous
  generation if the API changed).

### MCP

- `ballast_check` already returns unit/source/diff data; extend it with
  `artifacts`, `api`, `stores` and artifact diagnostics;
- add `ballast_artifacts({ project })` to list artifacts, token URLs (redacted
  except on explicit “show URL”), and build status;
- optionally add `ballast_artifact_screenshot({ project, artifact })` later:
  the service can render the artifact in a headless Chromium or ask the desktop
  window; do not make it part of v1;
- `ballast_apply` still never grants consent or creates action tokens; opening
  an action URL remains a user action.

### Guide and scaffold

- guide: artifact declaration, shared API, store usage, read-only vs action
  URL, no service secrets in artifact code;
- scaffold: add `artifacts/dashboard/main.tsx` + `src/api.ts` only when the
  user asks for an artifact (or add an optional `--artifact` flag); the default
  scaffold should stay minimal.

## 8. Manifest, diff and consent

Manifest additions:

```ts
artifacts: Array<{
  name: string;
  title?: string;
  entry: string;
  source: SourceLocation;
  fingerprint: string;
}>;

api?: {
  name: string;
  source: SourceLocation;
  procedures: Array<{
    name: string;
    kind: "query" | "action" | "stream";
    payloadSchema?: unknown;
    successSchema?: unknown;
    errorSchema?: unknown;
    fingerprint: string;
  }>;
};

stores: Array<{
  name: string;
  kind: "counter";
  initial?: number;
  source: SourceLocation;
}>;
```

Topics gain:

```ts
history?: { maxEntries: number; retentionMs: number } | false;
schemaFingerprint?: string;
```

Diff kinds gain `artifact`, `api`, `store` (or `apiProcedure`). A changed
artifact bundle is a change, not a consent event. A changed API procedure
schema restarts the generation like a timer/workflow schema change.

Consent:

- adding/removing an artifact, API, or store does **not** require consent by
  default: no new integration scope and no new connection;
- creating an **action-capable** OBS URL requires an explicit user
  confirmation naming the artifact and procedures exposed; a read-only URL does
  not;
- expanding a token from read to action, or exposing a new action procedure on
  an existing public token, requires confirmation;
- rotating/revoking a token is always allowed without consent.

## 9. Phased implementation

Sequenced after the typed `Ballast.Runtime` and one-project-per-window work,
because both touch the same core/worker/window surfaces.

### Phase 0 — spike (this round, isolated)

- Effect RpcGroup with a query, an action and a stream;
- artifact host/token proxy in front of a worker-like process;
- browser page built with rolldown/esbuild and tested with Playwright;
- proves serialization, streaming, bundling and token rejection.

### Phase 1 — core/planner contracts (after Runtime)

1. `Ballast.Artifact` declaration, source link, manifest unit.
2. `Ballast.Api.serve` with RpcGroup schemas and action annotations.
3. Planner artifact manifest extraction and dual typecheck config.
4. Browser bundle pass and artifact diagnostics in `CheckProject`.
5. Unit diff for artifact/api/store.

### Phase 2 — service host and metadata

1. Artifact host on a dedicated origin; immutable assets; CSP/sandbox.
2. Token store (hash, project/artifact/scopes, revoke/rotate).
3. Built-in metadata RPC (project, units, params, logs, timers, workflows).
4. Proxy to the project worker for custom API; action-scope enforcement.
5. Project window Artifacts section, full-screen iframe, pop-out.

### Phase 3 — OBS and streams

1. Stable OBS URL variants (read/action), transparency mode.
2. Streaming API bridge and disconnect/reconnect behavior.
3. Token rotation/revocation UX and audit.
4. Action-capable URL confirmation.

### Phase 4 — durable data

1. `Ballast.Store.counter` declarations, subscription history policy and manifest.
2. Service counter store RPC and subscription history persistence.
3. Dashboard example using counters + `query`/`watch` history + a stream.
4. MCP authoring additions and guide/scaffold snippets.

### Phase 5 — polish

1. Multiple artifacts per project and artifact picker.
2. Optional Solid template package.
3. Artifact screenshots/headless preview for agents.
4. Store value/collection variants.

## Implementation notes for the service agent

The questions are resolved by the Decisions section above. The remaining
integration details are:

1. **Metadata schema location:** use `@ballast/artifact/protocol` as the
   canonical `ArtifactMetadata` RpcGroup. It is browser-safe and already
   contains `SetParam` and `CancelTimer` action annotations. The client opens
   `/rpc` for the project API and `/metadata` for this group.
2. **Worker channel:** create a `MessageChannel` for each worker generation,
   pass `port2` as `workerData.artifactPort`, and keep `port1` in the runtime
   session. Use core's `makeArtifactRpcClient(port1, group)`; the group comes
   from the worker's `Api.serve` registration. Do not invent a second frame
   format.
3. **Store host:** implement the five `RuntimeHostHandlers` store methods and
   persist files under `.ballast/stores/`. Until then the in-memory fallback is
   used, which is correct only for `ballast run`.
4. **Tokens:** hash tokens in service state, bind them to one
   project/artifact/scope set, and enforce action/query per procedure. Creating
   or widening an action-capable OBS URL is a user confirmation flow; never do
   it from `ballast_apply`.
5. **Workspace UI:** the project units panel should list artifacts from the
   manifest; the artifact shell should use `sandbox="allow-scripts"`, a
   dedicated origin, and the iframe/CSP rules above.
6. **Scaffold dependency:** a scaffolded artifact project needs
   `@ballast/artifact` in its generated `package.json`; the template files are
   under `packages/artifact/template/`.

## Spike

Location: `spikes/artifacts/` (not in the pnpm workspace; only symlinked
workspace dependencies, no product code changed).

What it proves:

- an Effect `RpcGroup` with `Snapshot` (query), `Increment` (action) and
  `Events` (`stream: true`) runs in a worker-like process;
- a small WebSocket proxy checks a project-scoped token before upgrading and
  rejects an invalid token with 401;
- a browser page bundled with esbuild uses the typed `RpcClient` over that
  WebSocket, renders the snapshot, receives stream chunks and calls the action;
- Playwright verifies the page: initial count 1, streamed events appear, click
  increments to 2, more events arrive.

Commands:

```bash
# typecheck the spike
./node_modules/.bin/tsgo -p spikes/artifacts/tsconfig.json

# bundle the browser client
cd spikes/artifacts
./node_modules/esbuild/bin/esbuild src/client.ts --bundle --format=esm \
  --platform=browser --outfile=public/client.js

# run the worker-like RPC server + proxy
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/server.ts

# in another shell: browser + token check
cd spikes/artifacts
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/browser-test.ts
```

Observed result:

```text
security ok: invalid token rejected
browser ok: count=2 events=3 project=demo · generation 1
```

Server log:

```text
ARTIFACT_URL http://127.0.0.1:4311/?token=dashboard-action-token
ARTIFACT_CONNECTED client=1 project=demo scopes=read,action
```

Client bundle: about 302 KiB unminified (Effect included), built in ~33 ms.

### Spike gotchas

- **Effect RPC lives at `effect/rpc`, not `effect/unstable/rpc`** in
  effect 4.0.6. The unstable modules are re-exported at stable subpaths.
- **The wire is an envelope, not just the payload.** A custom protocol has to
  carry `Request`, `Chunk`, `Exit` and `Defect` messages. The JSON
  serializer's `EncodedSchema` is shaped for binary serializers (it expects
  `Uint8Array` chunk values); a browser WebSocket spike needs an explicit
  JSON envelope schema or must use the serializer's parser.
- **Streaming is chunk messages on the same socket.** The proxy must not buffer
  the stream; forwarding each `Chunk` as a WebSocket frame worked, and the
  client saw live events while the action stayed responsive.
- **Browser bundling works without a framework.** esbuild resolved Effect from
  the workspace install and produced one ESM bundle. Nothing in the artifact
  imported Node built-ins or the agent.
- **Token validation is not method authorization.** The spike gates the whole
  socket with a project token, but does not yet reject `Increment` for a
  read-only token. The production gateway must check each procedure's
  action/query kind against token scopes; this is the main security follow-up.
- **Two RPC paths need one auth model.** Metadata is served by the service,
  custom API by the worker. The gateway must attach the same project/session to
  both and never let a token cross projects.
- **OBS needs a stable URL.** A query token survives OBS restarts; rotation
  must update the copied URL and revoke the old one. Treat the URL as a
  capability and label action-capable variants clearly.
- **Artifact files need a DOM typecheck.** The worker config must not include
  DOM globals; a second generated config is required so artifact files can use
  `document`, `WebSocket`, etc.
