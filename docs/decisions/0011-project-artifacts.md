# 0011 — Project artifacts: custom project UI over typed RPC

*Status: proposed; isolated spike validated (2026-11-23) · depends on the typed
`Ballast.Runtime` work and the one-project-per-window UI work landing first ·
effect `4.0.6`*

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

export const DashboardApi = RpcGroup.make(
  Rpc.make("Snapshot", {
    success: Schema.Struct({
      count: Schema.Number,
      startedAt: Schema.Number,
    }),
  }),
  Rpc.make("Increment", {
    payload: { by: Schema.Number },
    success: Schema.Number,
  }),
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
`Rpc.make("Increment", ...).annotate(Ballast.Api.Mutation, true)`) so a UI
cannot infer write rights from a name. The default is read-only query.

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

### Routing

```text
artifact page / asset
  -> artifact host checks token, serves immutable bundle

artifact WebSocket /rpc?token=...
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

## 6. Dashboard data: `Ballast.Store`

Worker memory is lost on reload/restart, so an event log or counter that should
survive is not just a closure. **Recommendation: add durable, schema-typed
project stores as declared units.** Artifacts should not read arbitrary worker
memory.

Proposed v1 surface:

```ts
// declared in init
const scenes = yield* Ballast.Store.counter("sceneSwitches", { initial: 0 });
const alerts = yield* Ballast.Store.log("alerts", AlertEvent, {
  maxEntries: 500,
  retention: "7 days",
});

// handlers / Ballast.run / API actions
yield* scenes.increment(1);
yield* alerts.append({ kind: "follow", user: "ada", at: Date.now() });

// artifact API handlers
yield* scenes.get();       // number
yield* alerts.watch();     // Stream<AlertEvent>
yield* alerts.recent({ limit: 50 });
```

Units are named per project and manifest-recorded with schema/fingerprint and
source links. Storage lives under the project’s `.ballast/` directory, next to:

- `timers.json` — timer declarations/instances (0006);
- workflow store — workflow runs (0007, when integrated);
- `stores/<name>.json` — counters/values;
- `stores/<name>.jsonl` — append-only logs with retention/rotation.

Semantics:

- `counter` is an atomic integer with `increment`/`get`/`reset`;
- `log` is append-only with a max entry count and/or retention; `watch` is a
  live stream; `recent` is a bounded read;
- later `value` (JSON KV) and `collection` (keyed records) can share the same
  store RPC and file format;
- writes are serialized per project in the service; the worker calls store RPCs
  (`StoreGet`, `StoreIncrement`, `StoreAppend`, `StoreWatch`) over the
  runtime session;
- a store is a project-level unit: adding/removing it is diffed by name; data
  stays on disk but is ignored when the declaration is removed until the user
  deletes it;
- if the user wants a purely in-memory dashboard, they can keep state in the
  worker closure; that is explicitly non-durable and disappears on reload.

Artifacts query stores through the project API (or built-in metadata for
timers); stores are not a second HTTP surface. This keeps one auth model and one
project scope.

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
  kind: "counter" | "log";
  schema?: unknown;
  fingerprint: string;
  source: SourceLocation;
}>;
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

1. `Ballast.Store.counter` / `Store.log` declarations and manifest.
2. Service store RPC, atomic writes, retention/rotation, live watch.
3. Dashboard example using counter + log + stream.
4. MCP authoring additions and guide/scaffold snippets.

### Phase 5 — polish

1. Multiple artifacts per project and artifact picker.
2. Optional Solid template package.
3. Artifact screenshots/headless preview for agents.
4. Store value/collection variants.

## Open questions for the user

1. **UI framework:** confirm DOM-first TS/TSX for v1, with a Solid template
   later, or make Solid the blessed template now?
2. **Write access:** should v1 allow `SetParam`/timer cancellation from an
   artifact, or keep every artifact read-only and add writes after the live
   param work stabilizes?
3. **Token transport:** accept a URL token for OBS (with rotate/revoke), or
   require a first-message handshake and accept less convenient Browser Source
   setup?
4. **Action URLs:** should creating an action-capable OBS URL require a
   one-time explicit confirmation/consent? (Recommendation: yes.)
5. **Store scope:** ship counters + append-only logs first, or wait for a full
   KV/collection API? (Recommendation: counters + logs.)
6. **API cardinality:** one API group per project for v1, or named multiple
   groups from day one? (Recommendation: one; the manifest already records the
   group name.)
7. **Artifact API exposure:** should every declared procedure be callable from
   every artifact, or should artifacts opt into procedure subsets in the
   declaration? (Recommendation: all project procedures by default, with token
   scopes for action.)

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
