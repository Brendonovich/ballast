# Ballast: handoff

*Last updated 2026-11-23. Status: **Phase 0 spike complete** — plan, run and hot reload work end to end, and decision 0004 removed Alchemy from the script runtime. The next task is **Phase 1: the local agent plus OBS and VTube Studio**.*

Read `docs/PLAN.md` first. This file covers what has been decided, what is still open, where to look, and exactly what to build next.

---

## 1. Background

Ballast started from a conversation about MacroGraph (Brendan's visual automation tool, v2 rewrite in `~/github.com/brendonovich/cf-effect-experiment`). A friend wants to **build streaming setups for other streamers and deploy them to their machines**. That led to these conclusions:

- The logic has to **run on the streamer's own PC**, because that's where OBS, VTube Studio and the other tools run.
- **Writing the logic isn't the hard part anymore**, since agents can write it. The hard parts are:
  1. integrations with external services, behind one standard event/request model
  2. receiving cloud events (Twitch, Ko-fi…) and delivering them to a desktop
  3. connecting machines (creator ↔ client, cloud ↔ desktop)
- So Ballast is **a separate app from MacroGraph**, focused on integrations plus a scripting engine. Graphs are out of scope.

## 2. Decisions so far

| # | Decision | Why |
|---|---|---|
| D1 | Separate product and repo; nothing is imported from MacroGraph | Different focus; MacroGraph is built around graphs |
| D2 | **Scripts only** for now (no graphs) | Agents write code well; avoids editor/graph work |
| D3 | **Scripts are written with Effect and `@ballast/core`**; Alchemy is only a cloud deployment tool | Running a script's init against the plan layer reveals its subscription topics, credentials/scopes, local connections and params *before it runs*. Decision 0004 dropped Alchemy from the script runtime |
| D4 | Logic runs on the **desktop agent**; the **cloud** handles OAuth, the token vault, webhook/EventSub ingress and a per-machine relay | Local tools need local execution; webhooks need a public host that's always on |
| D5 | Each project has one live copy, on the desktop. Editing is **live and collaborative**, with **no offline edit reconciliation** | Keeps editing simple: the agent orders all edits; no CRDT or merging |
| D6 | Project **state lives only on the desktop**; the cloud sees it only through the live connection | Simpler; nothing to sync |
| D7 | Artifacts (later) are **HTML** bound to state and actions (`data-field` + a `connect()` JS API), also usable as OBS docks | Flexible and easy for agents to write |
| D8 | The desktop shell (later) is **Rune + CEF**, the same approach as the OpenCode Desktop rewrite; Electron is the fallback | See §6 |
| D9 | The cloud runs on **Cloudflare**, deployed with Alchemy | Same stack as MacroGraph cloud; Durable Objects suit the per-machine relay |

## 3. Open questions (not decided)

1. ~~**How much of Alchemy to use:** use the Platform/Binding/Plan engine directly, or only the script shape with Ballast's own recorder?~~ **Answered by 0004:** none in the script runtime; Alchemy stays in `apps/cloud` for deployment.
2. **Twitch delivery:** per-user EventSub webhooks or a conduit? Check subscription cost limits before Phase 2.
3. **Stale events:** default `maxAge` (draft: 60 s) and how long the relay keeps events (draft: 24 h).
4. **Script isolation** beyond `worker_threads`, needed before scripts written by other people are distributed.
5. **Remote repo:** not created yet; local only (`main`, no remote).

## 4. Where to look

### Alchemy (cloud deployment only since 0004)
The script runtime no longer uses Alchemy. These references are still useful for
`apps/cloud`'s deployment (`alchemy.run.ts`, Cloudflare providers) and for the
history in decision 0001.
- **Installed version (beta.84, the one MacroGraph uses):** `~/github.com/brendonovich/cf-effect-experiment/apps/cloud/node_modules/alchemy/src`. In this repo it is installed under `apps/cloud`.
- **Repo clone:** `~/github.com/alchemy-run/alchemy-effect`. It's older (Jun 2026), so run `git pull` before using it. Docs: https://v2.alchemy.run (index at `/llms.txt`).
- Files to read, in order:

| File | Why |
|---|---|
| `Phase.ts` | `__ALCHEMY_RUNTIME__` (bundler-defined) and `ALCHEMY_PHASE` ("plan" / "runtime") |
| `Binding.ts` | `Binding.Service`: tag + callable + `execute`. `Binding.Host` resolves the host only at deploy time |
| `Platform.ts` | How a host type (Worker, Lambda, process) is defined; `provideClassLayer`; init has **no `Scope`**, while handlers get one per event |
| `RuntimeContext.ts` | `BaseRuntimeContext`: `set`/`get` env capture, `hostServices`, `serve`, `exports`. This is how `Config` values become env; Ballast params should work the same way |
| `Runtime/Process.ts` | `ServerHost.run` and `createHostRuntimeContext`: the long-running process host, the closest match to a desktop worker |
| `WebhookHost.ts` | A service the host provides that event sources use, routing deliveries by path. The model for Ballast's `EventHost` |
| `Plan.ts`, `Stack.ts`, `Apply.ts`, `State/` | How a plan is built and applied, and the state store interface |
| `Bundle/Bundle.ts` (`ALCHEMY_DEFINE`, ~line 163) | The defines the runtime bundle needs |
| `@alchemy.run/github/src/RepositoryEventSource.ts` + `RepositoryEventSourceLive.ts` | **Background for 0001 (no longer used):** it provisions a webhook at plan time (behind `!__ALCHEMY_RUNTIME__`) and routes deliveries at runtime. Ballast now implements the split with `EventHostPlan`/`EventHostRuntime` |

- How MacroGraph uses Alchemy: `cf-effect-experiment/apps/cloud/alchemy.run.ts`, `apps/cloud/src/worker/*`. MacroGraph patches `@alchemy.run/cloudflare@2.0.0-beta.84` (`cf-effect-experiment/patches/`), so check that patch before Phase 2 cloud work.

### Integrations (port from here)
`~/github.com/brendonovich/cf-effect-experiment/packages/modules/*`: obs, twitch, vtube-studio, kofi, streamlabs, discord, openai, elevenlabs, speakerbot, voicemod, goxlr, streamdeck, midi, websocket-*, … The engine model is in `packages/module/src/Engine.ts`; Twitch OAuth and EventSub are in `apps/cloud/src/TwitchCredentials.ts`, `apps/cloud/src/ingress/` and `packages/cloud-credentials`.

### Desktop shell (later)
`~/github.com/anomalyco/rune` (`PLAN.md`) and `~/github.com/anomalyco/rune-desktop` (`crates/browser-pane` = CEF sidecar; `crates/opencode-kit` = discovering a service through `service.json`, the pattern to copy). Check Windows support for `browser-pane`: it uses a Unix socket and `mach_pipe.rs`.

## 5. Repo state

```
ballast/
├── AGENTS.md            agent rules (source of truth, coding, verification)
├── README.md
├── docs/PLAN.md         full plan (concepts, script model, integrations, architecture, phases, risks)
├── docs/HANDOFF.md      this file
├── package.json         pnpm 12.2.1, tsgo typecheck
├── pnpm-workspace.yaml  apps/*, packages/*, packages/integrations/*, examples; catalog: effect 4.0.6, alchemy 2.0.0-beta.84
├── tsconfig.base.json   strict, bundler resolution, .ts imports, composite
└── tsconfig.json        project references to every package
```

Phase 0 now fills in these packages:

```
packages/core                 @ballast/core: Script host, Param, EventHost, Manifest, RPC schemas
packages/planner              @ballast/planner: plan worker, manifest recorder, diff
packages/integrations/fake    @ballast/fake: fake/tick, fake/chat, fake/echo
apps/agent                    @ballast/agent: ballast CLI, runtime host, worker sessions, hot reload
examples                      tick-echo.ts and future sample scripts
```

Versions match MacroGraph so known-good versions of Effect and Alchemy are used together in the cloud. `@ballast/core` and `@ballast/planner` use Effect only; `rolldown` does runtime bundling.

## 6. Phase 0 plan/runtime spike (complete)

**Goal:** show that a Ballast script's init can be planned on its own into a manifest and then run in a Node worker with events delivered to it, with hot reload. Phase 0 started on Alchemy's host model and finished on the step 7 fallback; decision 0004 records why.

### Step 1: Workspace
Create:
- `packages/core` (`@ballast/core`)
- `packages/planner` (`@ballast/planner`)
- `packages/integrations/fake` (`@ballast/fake`)
- `apps/agent` (`@ballast/agent`, with the `ballast` CLI bin)
- `examples`

Each gets a `tsconfig.json` extending `../../tsconfig.base.json` and is added to root `references`. Dependencies come from the catalog: `effect`, `@effect/platform-node`, and `@effect/vitest` + `vitest` for tests. `alchemy` is only in `apps/cloud`.

### Step 2: Read Alchemy and write down the answers
Answer these in `docs/decisions/0001-alchemy-as-script-framework.md`:
1. How does `Platform` build a host resource, and can a third party define a new host type (`Ballast.Script`) with its own `RuntimeContext` and `hostServices`?
2. Can the plan for **one** platform resource run without a full `Stack` deploy, using an in-memory or SQLite state store and only Ballast's providers?
3. What does plan need from providers? Can Ballast's `TopicSubscription` provider be a stub at first (later calling the Ballast cloud API)?
4. What does the runtime bundle need besides `ALCHEMY_DEFINE`? Can the agent bundle a script itself (rolldown/esbuild) and run its init with `ALCHEMY_PHASE=runtime`?
5. How do `Output`s that can't be resolved at plan time (params that affect topics) appear in a plan?

### Step 3: `@ballast/core`
- A script is an Effect default export. `evaluateScript(effect, phase)` provides the plan or runtime host layer and collects `Ballast.run` loops; the runtime host is a worker. `Ballast.Script` is a type only. (0004 replaced the original Alchemy platform.)
- `EventHost` service: `subscribe(topicKey, handler)`. At plan time it records the subscription; at runtime it registers the handler with the host bus.
- `Param.string/number/boolean/enum(key, opts)`: at plan time it records into the manifest; at runtime it returns an `Effect` that reads the current value (settings may change while the script runs).
- `Ballast.run(effect)` for long-running loops (like `ServerHost.run`).
- `Manifest` as an Effect Schema:

```ts
Manifest = {
  script: { id: string },
  params: Array<{ key; type: "string" | "number" | "boolean" | "enum"; title?; default?; options?: { integration; slot; source } }>,
  connections: Array<{ integration; slot; location: "local" | "cloud" | "either" }>,
  topics: Array<{ integration; slot; topic; scopes: string[]; onStale: "drop" | "deliver"; maxAgeMs: number }>,
  requests: Array<{ integration; slot; request; scopes: string[] }>,
  unresolved: Array<{ path; reason }>,   // Outputs only known at apply
}
```

### Step 4: `@ballast/fake`
A test integration that needs no external service:
- `Fake.Connection(slot)` (location `local`)
- topic `fake/tick` with payload `{ n: number }`, declared with scope `fake:read`
- request `fake/echo` (`{ text } → { text }`) with scope `fake:write`
- a local driver in the agent that emits `tick` every second

### Step 5: `@ballast/planner` + `ballast plan`
- `plan(entry: string): Effect<Manifest>` evaluates the script in a throwaway worker in plan phase and collects the manifest.
- `diff(prev, next)` returns added/removed topics, scopes, connections and params, flagging `requiresConsent` when scopes or connections are added.
- CLI: `ballast plan examples/tick-echo.ts` prints the manifest as JSON; `--diff <prev.json>` prints the diff.

### Step 6: Runtime + `ballast run`
- Bundle the script with the Ballast runtime define and run it in `worker_threads`. The host provides `EventHost`, request clients and params over Effect RPC on the worker's `MessagePort`.
- The agent's event bus sends `fake/tick` from the driver to subscribed handlers.
- Watch the file: on change, plan again → diff → (apply automatically if no consent is needed) → start the new worker → stop the old one's scope.
- CLI: `ballast run examples/tick-echo.ts --param prefix=hi`.

### Step 7: Fallback (adopted by decision 0004)
Keep the exact script-facing API from Step 3. Write the plan phase yourself: a plan layer whose `EventHost`, params and capability bindings record into a `Ref<Manifest>`, and whose request clients **die** if called. Run init once against that layer. This is now the implementation; see `docs/decisions/0004-drop-alchemy-from-script-runtime.md`.

### Example script for the spike (`examples/tick-echo.ts`)
```ts
import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const prefix = yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
    const fake = yield* Fake.Connection("main");
    const echo = yield* Fake.Echo(fake);
    yield* Fake.onTick(fake, (tick) =>
      Effect.gen(function* () {
        const { text } = yield* echo({ text: `${yield* prefix} tick ${tick.n}` });
        yield* Effect.log(text);
});
  }),
);
```

### Exit criteria (all must be shown working, not just compiled)
- [x] `ballast plan examples/tick-echo.ts` prints a manifest with: param `prefix`, connection `fake/main`, topic `fake/tick` (scope `fake:read`), request `fake/echo` (scope `fake:write`).
- [x] Planning makes **no** request calls and opens no connections. The plan client dies; `call-request.ts` tests the failure, and `plan` never evaluates handlers.
- [x] `ballast run` logs `> tick 1`, `> tick 2`, … (and `hi tick N` with `--param prefix=hi`).
- [x] Changing the prefix in the file hot-reloads with no duplicate handlers; the old worker is terminated and its session scope closes.
- [x] Adding `Fake.onChat` causes `requiresConsent: true` and the run pauses at `Apply? [y/N]`. Yes starts a new worker; no keeps the old one running.
- [x] Decision records 0001 (hybrid, superseded) and 0004 (Ballast plan/runtime layers, no Alchemy in the script runtime).
- [x] `pnpm typecheck` and `pnpm test` pass.

### Phase 0 result and deviations

The spike first used Alchemy's `Platform`/`RuntimeContext`/`hostServices`/phase handling, but not `Stack`/`Plan`/`Apply`/`Provider`/`State`. Decision 0004 then replaced that host model with Ballast's own plan/runtime layers; `@ballast/core` no longer imports `alchemy`. The manifest was always Ballast's own recorder. Implementation notes:

- **Runtime RPC was built as a custom Effect RPC `Protocol` over a dedicated `MessageChannel`.** The built-in worker transports are one-directional for this use case: `RpcClient.layerProtocolWorker` is a host-side client pool that spawns its own workers, and `RpcServer.layerProtocolWorkerRunner` makes the worker the server. The script worker needs to be the RPC *client* of host services, so the agent serves `RuntimeRpcs` on one port and the worker runs `RpcClient.make` on the other. Event delivery uses ordinary `parentPort` messages after the worker registers a topic; only subscriptions, params and requests use RPC.
- **`Ballast.run` uses a `ScriptRunner` host service, not Alchemy's `ServerHost`.** `alchemy/Runtime/Process` is exported as raw TypeScript from the package, which Node's type stripping cannot load from `node_modules`; the `run`/`exports.program` shape is copied.
- **`providePlan` lives in `@ballast/core`, not `@ballast/planner`.** Scripts never import `alchemy`; since 0004 neither core nor planner does.
- **Script identity comes from the path, not a wrapper prop.** The manifest `script.id` is project-relative for the service, or cwd-relative/file-basename for `ballast plan`/`run`; an optional `export const title` overrides the humanised display name.
- **Static enum values are not in the manifest.** The fixed HANDOFF shape has no field for them; `Param.enum(key, values, opts)` validates the value at runtime, but UI/MCP consumers cannot see the allowed values yet.
- **Consent is driven by new scopes or new connection slots.** A new topic whose scopes are already granted does not prompt. Changes that only alter defaults or handler code still restart the worker when the file content changes.
- Runtime bundling uses **rolldown** with `globalThis.__BALLAST_PHASE__ = "runtime"` and `codeSplitting: false`. A custom resolver lets a script copied to a temp folder bundle without its own `node_modules`. Alchemy's Bun-only dynamic imports are no longer in the bundle (0004).

## 7. Next task: Phase 1
Follow `docs/PLAN.md` §9:
- **Phase 1 (next): the agent service, project store, and `@ballast/obs` + `@ballast/vtube-studio` local drivers.** Wire the integration catalog and generated types, settings and logs. **Exit:** a script that switches OBS scenes when a VTube Studio hotkey fires runs, reloads on save and logs to the CLI.
- Phase 2: cloud, pairing, OAuth vault, Twitch EventSub, relay Durable Object
- Phase 3: web editor (collaborative), plan diff UI, event inspector and replay
- Phase 4: more integrations + MCP

Update this file at the end of each phase: status line, decisions, open questions, next task.
