# Ballast: handoff

*Last updated 2026-11-23. Status: **local agent + desktop shell work end to end**. The real
`apps/agent` service is staged by the desktop dev/pack scripts, the Electron shell (or CLI) starts
it as a detached background process, and the Playwright E2E proves start → fake-tick script → UI →
quit UI with the service still running → stop with no process left. Phase 1 drivers (OBS,
VTube Studio, Twitch, MIDI, keyboard, WebSocket, HTTP/webhooks) are implemented and tested against
mocks; real-world validation is the next gate.*

Read `docs/PLAN.md` first. This file covers what works, the decisions, how to run it, what is
still open, and what to build next.

---

## 1. What works

- **Script model.** A script is an Effect default export using `@ballast/core` (params, connections,
  topics, requests, `Ballast.run`). Plan mode records a manifest without making requests; runtime
  mode delivers events through the agent host. The runtime bundles scripts with rolldown so a
  project does not need its own `node_modules`.
- **Planner + CLI.** `ballast plan`, `ballast run`, project/script/connection/consent/cloud/service
  commands. `plan` and `run` are in-process; the rest are clients of a running `ballast serve`.
- **Agent service.** `ballast serve` owns projects, scripts, connections, cloud pairing, logs/events
  and consent. It writes `service.json` (0600), enforces one service per user with `service.lock`,
  serves the Solid UI at `/`, unauthenticated `/health` for discovery, and typed Effect RPC at
  `/rpc`. `ShutdownService` exits 0; restart is stop + spawn by the caller. The CLI's
  `ballast service start|stop|restart|status` manages it, and other service commands start it in
  the background when none is running. Service commands accept `--state-dir` and
  `--data-dir` (or the matching environment variables), print the `service.json` they
  select, and refuse to act when more than one running service matches.
- **Desktop shell.** One Electron window (token → HttpOnly cookie), tray/menu, versioned service
  staging, detached `ballast serve` spawn on every launch (adopt same version, replace another
  version with rollback), stop-before-app-update, and a typed `window.ballast` bridge. No OS
  supervisor or start at login. Quitting the UI does not stop the service.
- **Integrations.** OBS WebSocket, Twitch (local-app + cloud modes, EventSub, Helix), VTube Studio
  (plugin auth/events/hotkeys), keyboard (libuiohook), MIDI, WebSocket client/server, and
  generic local/cloud webhooks (outgoing HTTP uses Effect's `HttpClient` directly). Local
  integrations grant their whole request namespace from
  the connection handle (for example `midi/*`, `keyboard/*`, `websocket/*`, `fake/*`);
  per-request declarations remain only where a request carries permission scopes. The fake
  integration drives the E2E and unit suites.
- **Durable timers.** Scripts declare a timer with
  `Ballast.Timer.subscribe(name, schema, handler, options)`, schedule with
  `after(key, duration, payload)` and handle fires as events. The service persists one `<project>/.ballast/timers.json` per project
  (atomic 0600, per-project writes, corrupt-file quarantine), validates schedules against the
  applied manifest/fingerprint, applies the late policy, delivers once to the active generation,
  and keeps pending entries through stop/restart. Timer identity is project + timer name + key.
  `ballast run` keeps an in-memory timer store.
- **Local SQLite databases.** A script declares a database in init with
  `Ballast.Database("name")` and runs raw SQL through the effect/sql `SqlClient`
  (`const sql = yield* db.client`) in handlers, `Ballast.run` or timer/API handlers;
  reading it during init is a runtime-value type error. The agent owns the file
  `.ballast/db/<name>.sqlite` (via `@effect/sql-sqlite-node`, i.e. Node's built-in
  `node:sqlite`; no native dependencies) and the worker executes SQL over the
  `DatabaseExecute` runtime RPC, so connections close cleanly across hot reload.
  Declarations appear in `ballast plan` under `databases`. There are no migrations
  and no database inspector yet.
- **Project bundles (0008 W4).** A `ballast.ts` project is planned as one bundle through the
  `tsgo` gate, diffed by unit kind/name, and run as one worker. A new project starts stopped; a
  project starts/stops/enables as a whole. File changes cut over to a new generation immediately
  and close the old worker after a 30s grace period. A typecheck/bundle/plan failure keeps the old
  worker and publishes `reload-failed` with the file/line. State is project-scoped:
  `.ballast/settings.json` (`enabled`, `params`) and `.ballast/applied.json`. This is a clean
  reset; old per-script state is not migrated.
- **Artifact URLs outside the app.** Artifacts are served by a dedicated
  `127.0.0.1` gateway (default port 47831, `BALLAST_ARTIFACT_PORT`) with a
  strict CSP, so Chrome or an OBS Browser Source can load them with no Electron
  preload or bridge. Artifacts are private to the project, so every artifact
  URL has full access to the project API. Each project has a stable token
  derived from `.ballast/artifact-secret`; `Ballast.Artifact(...)` returns a
  handle whose `url` is a plan/runtime bundle constant, usable in init.
  Persistent URLs remain random and stored (0600, so they can be copied
  again). The "Artifact URLs…" dialog copies the stable URL and every
  persistent URL; the external-browser flow was exercised with Playwright
  against the real service (`apps/agent/test/artifacts-gateway.test.ts` covers
  restarts).
- **Live params and runtime types.** A param change is pushed to the running
  worker's `Settings` Ref; the next read in a handler or `Ballast.run` loop sees
  it without a restart or generation change. `Ballast.Runtime` makes param,
  request and timer/workflow reads type errors in init; the gate's generated
  entry check reports a clear message, and `satisfies Ballast.Project` gives the
  editor the same error at the offending line.
- **Cloud.** Cloudflare Worker/Alchemy app for OAuth, Twitch EventSub and webhook ingress, machine
  pairing/relay, and a per-machine RPC link. It typechecks and has protocol/unit tests; a deployed
  end-to-end run is still a next task.
- **Share sign-in (0014).** Publishing uses Sign in with Anomaly, not cloud pairing;
  subscribing needs only the share link (`{server}/s/{code}`), no sign-in.
  `ballast shares login` (or Settings → Sharing) signs this machine in to a share server
  (the cloud by default, `BALLAST_SHARE_SERVER`/`--share-server` or `ballast shares default`
  for another); projects remember their server. Register the cloud with
  `apps/cloud/scripts/anomaly-client.mjs` and set `ANOMALY_CLIENT_ID`/`ANOMALY_CLIENT_KEY`.
- **Project sharing (0013).** An author runs `ballast projects share <id>` (or the
  Share action / MCP `ballast_share`) to push the project to a Cloudflare Artifacts repo
  through the cloud and get an unlisted share code; `deploy` pushes new versions with
  isomorphic-git (no git install). `ballast projects subscribe <code>` installs a read-only,
  stopped copy on another machine. Deploys reach subscribers as a `share_update` relay
  message (plus a 5-minute poll for offline machines) and show as "update available";
  `ballast projects update <id>` / "Apply update" downloads only the changed files, verifies
  their git SHAs, swaps them in with a rollback journal while the project's sync is paused,
  and reloads once. Storage is its own cloud package (`packages/shares-api`: D1,
  Artifacts namespace, shares API Worker) that the cloud stack includes and calls over a service
  binding; the cloud keeps auth, authorization and the relay push. Exercised end to end
  against local `alchemy dev` (cloud + shares API Workers) + wrangler's Artifacts simulator with
  two services paired as different users; not yet against deployed Artifacts.
  **Subscribed code runs unsandboxed.**
- **Onboarding.** First run (no projects, not skipped; stored in `localStorage`) opens
  `#/welcome`, also reachable from Projects → Get started. *Build a project* creates one and
  connects coding agents; *Use a shared project* takes a share link (`{server}/s/{code}`, parsed
  by `parseShareInput`, with the share-server sign-in prompt) or a bare code, or opens a local
  folder. `GetProjectAgentSetup` / `WriteProjectAgentConfigs` (also `ballast projects agents`
  and the project menu's "Configure coding agent…") merge a `ballast` server into
  `opencode.json`, `.mcp.json` (Claude Code) and `.codex/config.toml`. Configs start
  `<dataDir>/bin/ballast-mcp`, a launcher the service rewrites on every start with its runtime,
  entry and state/data dirs, so they survive updates and non-default installs; shares leave these
  configs out. The cloud serves a small `/s/{code}` page for share links. Exercised against a real
  service (UI flow, files, MCP `tools/list` + `ballast_status` through the launcher, and
  `opencode mcp list` showing `ballast` connected once the folder is a git repository; outside
  one, OpenCode 2.2.5's `mcp list` showed no servers at all, global ones included).
  `BALLAST_TEST_ONBOARDING=1` boots any entry point as a fresh install: the desktop app, CLI and
  `ballast serve` point state/data/projects/logs (and the Electron profile) at a new temp root
  shared through `BALLAST_TEST_ONBOARDING_ROOT`, with an ephemeral artifact port; the creator
  removes it on exit (the desktop app stops its temporary service first). In the web dev server
  the mock starts empty and a previous Skip is forgotten on load.
- **Verification.** `pnpm typecheck` and `pnpm test` pass across the workspace. Project-bundle
  planning is also exercised from the built `apps/agent/dist-service` against a temporary project
  outside the repo. The desktop E2E
  (`pnpm --filter @ballast/desktop test:e2e`) passes on macOS against the real service. The black-box cloud suite (`packages/e2e`, run under fnm 24.22.2)
  passes Twitch cloud mode (pairing, signed EventSub delivery to a worker, relay buffering/replay,
  owner-keyed reconcile) and cloud webhooks; its local-app/Twitch-CLI scenario is skipped because
  Twitch CLI's mock API is not a drop-in Helix/OAuth server.

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| 0001 | Alchemy as the script framework (Plan/Binding/RuntimeContext shape) | **Superseded by 0004**; kept for history and cloud deployment context |
| 0002 | Twitch auth modes (local-app and cloud) + cloud OAuth vault/EventSub/relay | Implemented; local and cloud paths tested with mocks |
| 0003 | Desktop shell, background agent service and local API (AgentRpcs, `service.json`, `/health`, detached background process, versioned stages, quit-UI vs stop-service) | Implemented; E2E covers the lifecycle on macOS |
| 0004 | Drop Alchemy from the script runtime; Ballast plan/runtime layers, Effect only in core | Implemented |
| 0005 | Generic webhooks through the cloud relay, plus local webhook transport, verification and limits | Implemented; real provider validation pending |
| 0006 | Durable timers as declared, schema-typed events persisted per project; no resumable `sleep` | Core, planner and service integration implemented and tested; recurring/cron remains future work |
| 0007 | Effect workflows with a durable engine | Deferred: service integration was canceled for the decision 0008 project-model redesign; the `packages/workflow` prototype stays with its own workstream |
| 0008 | Project = one bundle with an explicit `ballast.ts` entry and named declarations | W4 service runtime and the protocol half of W5 implemented; UI half remains |
| 0014 | Share servers + Sign in with Anomaly for publishers (subscribers use share links only): the share server is the OIDC client (PAR, private_key_jwt, DPoP), loopback handoff to the agent, per-project servers, polling instead of relay push | Implemented; verified locally against a strict test issuer; not yet against account.anoma.ly (needs client registration) |
| 0013 | Project sharing: one-way shares (share/deploy/subscribe/update) over Cloudflare Artifacts, manifest diffs, staged atomic apply; shares API in `packages/shares-api` behind the cloud | Implemented; verified locally with the wrangler Artifacts simulator bridge; deployed Artifacts untested |

## 3. Packages and apps

| Path | Role |
|---|---|
| `packages/core` | `@ballast/core`: script API, manifest types, plan/runtime host layers, runtime RPC |
| `packages/planner` | `@ballast/planner`: plan worker, manifest recorder, diff/consent rules |
| `packages/agent-protocol` | Schemas, `AgentRpcs`, `AgentClient`, mock layer, service events (including `script-source-changed` and `timer-fired`), timer list/cancel RPCs |
| `packages/cloud-protocol` | Cloud worker/protocol schemas shared by agent and cloud |
| `packages/integrations/fake` | Deterministic tick/chat/echo integration for tests and the E2E |
| `packages/integrations/obs` | OBS WebSocket driver, events, scene/source requests |
| `packages/integrations/twitch` | Twitch transport (local/cloud), EventSub messages/signature, Helix, scopes |
| `packages/integrations/vtube-studio` | VTS plugin auth, status/approval state, events, hotkeys, params |
| `packages/integrations/keyboard` | Global keyboard driver; macOS Accessibility hint/status |
| `packages/integrations/midi` | MIDI input/output driver |
| `packages/integrations/websocket` | WebSocket client/server driver and JSON helpers |
| `packages/integrations/http` | Local webhook server, verification and cloud relay adapter; outbound HTTP uses `effect/http` |
| `packages/e2e` | Cross-package protocol tests (no product UI) |
| `apps/agent` | `ballast` CLI + `ballast serve` service + `dist-service` build |
| `apps/web` | Solid web UI served by the agent (scripts, source, logs, connections, settings) |
| `apps/desktop` | Electron shell: service launcher, tray, bridge, updater |
| `packages/shares-api` | Shares API (D1, Artifacts namespace, Worker) as Alchemy resources; included by the cloud stack, deployable on its own |
| `apps/cloud` | Cloudflare Worker: OAuth vault, Twitch EventSub, webhooks, machine relay |
| `examples` | Example scripts (tick, OBS, Twitch, VTS, MIDI, keyboard, WebSocket, webhook) |

## 4. Run it

```bash
pnpm install
pnpm typecheck
pnpm test
```

```bash
# Local service + CLI
pnpm --filter @ballast/agent serve
node --experimental-strip-types --no-warnings=ExperimentalWarning apps/agent/src/bin.ts status
# or start/stop it in the background: ... bin.ts service start|stop|restart|status
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts projects add ./examples --name Examples

# Web UI (Vite, mocked/live store) or through the service
pnpm --filter @ballast/web dev
pnpm --filter @ballast/web build

# Desktop: Vite HMR against the real service + Electron. The agent service and
# Electron main/preload build once per launch. A rebuilt service gets a new
# content-hashed dev version, so dev replaces the running service with it.
pnpm dev
# Production-style built UI, or an already-running dev UI:
BALLAST_VITE_DEV=0 pnpm --filter @ballast/desktop dev
BALLAST_UI_URL=http://localhost:5173 pnpm --filter @ballast/desktop dev

# Real Electron E2E: real service, real UI + screenshot, service outlives the UI
pnpm --filter @ballast/desktop test:e2e

# Package (unsigned local build; Resources/service is outside app.asar)
pnpm --filter @ballast/desktop run pack

# Cloud (Alchemy; needs Cloudflare credentials/var files)
pnpm --filter @ballast/cloud deploy

# Durable timers: in-process demo (the service persists them)
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts run examples/timer-cooldown.ts
```

Timer protocol additions: `ScriptManifest.timers`, `TimerSummary`, `ListTimers`
(`projectId?`, `scriptId?`, `includeFinished?`), `CancelTimer`
(`projectId, scriptId, timer, key` → `{ cancelled }`), and the `timer-fired` service event.
The runtime RPCs `RegisterTimer`, `ScheduleTimer` and `CancelTimer` are internal to the worker.

Project protocol additions: `CreateProject({ name, directory? })` (scaffolds a stopped
project; base dir is `BALLAST_PROJECTS_DIR`, default `<home>/ballast-projects`),
`CheckProject({ projectId })` (non-applying typecheck/bundle/plan/diff with diagnostics),
`ProjectSummary`/`ProjectDetail` with `units`, `ProjectManifest`,
`ListProjectFiles`, `ReadProjectFile`, `GetProjectSource`, `PlanProject`, `StartProject`,
`StopProject`, `RestartProject`, `SetProjectParam`, `SetProjectEnabled`,
`ListProjectConsents`, `ApproveProjectConsent`, `RejectProjectConsent`, plus unit filters on
logs/events and the `project-changed`/`reload-failed` events. The older script RPCs remain while
the UI cuts over.

The desktop service build is `apps/agent/scripts/build-service.mjs`; the desktop helper runs
`apps/web` build first. It ships `tsgo`, `@types/node`, and the `@ballast/*`/`effect` sources
so project planning/typechecking works from `dist-service` outside the repo.
`BALLAST_SERVICE_BUILD_DIR` overrides the source and `BALLAST_SERVICE_SKIP_BUILD=1` reuses an
existing `dist-service`.

## 5. Open questions

1. **Secrets storage.** Connections/secrets are currently 0600 JSON under `BALLAST_DATA_DIR`.
   Decide when to move to a keychain/credential manager and how headless Linux behaves.
2. **Twitch delivery at scale.** Per-user EventSub subscriptions vs a conduit; check cost/limits
   before relying on cloud Twitch for many machines.
3. **Stale event defaults.** Draft `maxAgeMs` (60 s) and relay retention (24 h) need product
   decisions, especially for webhooks and Twitch.
4. **Script isolation.** `worker_threads` is not a security boundary. Decide on disabling Node
   built-ins/using isolates before distributing scripts written by others.
5. **Windows support.** Run the detached service spawn, stop and app update on a real Windows
   machine (no console window, survives the app quitting).
6. **Signing/notarization/update feed.** Decide the release channel and whether the service and
   app update independently or together.
7. **Input Monitoring.** Electron exposes Accessibility but not Input Monitoring; decide whether a
   native helper is needed for complete macOS keyboard diagnostics.
8. **VTS approval UX.** The service now exposes a distinct approval flag; decide whether the shell
   should deep-link/focus VTube Studio or just explain the dialog.

## 6. Known gaps

- **Real-world integration validation** is incomplete: OBS, Twitch, VTube Studio, MIDI hardware and
  the keyboard/accessibility flow are tested with mocks, fake backends or unit tests. The cloud
  EventSub/webhook path now has a real cloud + real service test, but the provider and local apps
  themselves still need a manual pass on macOS and Windows.
- **macOS keyboard permission** is queried by the shell
  (`systemPreferences.isTrustedAccessibilityClient`) and reported to the service through
  `ReportShellPermission`; keyboard connection rows carry an `accessibility` approval flag. Input
  Monitoring still has no public Electron query, and grant changes may need a service/keyboard
  reconnect (the service reconciles on report).
- **VTube Studio approval** is a distinct `ConnectionApproval` (`kind: "vtuber-studio"`) and the
  connection stays `connecting`, not `reauth-required`. The web UI currently renders the generic
  connection status; a dedicated approval call-to-action is still needed.
- **Source-change events** are emitted by the service's one-second project sync, not an OS file
  watcher. That is adequate for the UI refetch but adds up to ~1 s latency.
- **Windows** has not been exercised; the E2E has only been run on macOS.
- **App updater** is wired through electron-updater but an unsigned local build has no feed; a
  signed app-update run is untested.
- **Cloud deployment** has unit/protocol tests and a local demo path, but no deployed
  worker + paired machine + Twitch/webhook end-to-end run is recorded here.
- **Real webhook providers** (Ko-fi/Streamlabs-like payloads) need validation against their live
  signatures/timestamps.
- **Durable timer UI** is not built yet. The service exposes declarations, pending/fired rows and
  cancel; the web UI still needs a timer list/countdown and a `timer-fired` toast/badge.
- **Packaging** needs an icon, signing/notarization and a release feed; local `pack` is unsigned.
- **Concurrent `packages/workflow`** (durable workflow engine) is untracked new work by another
  workstream; its tests fail independently and should be resolved there. Workflow service
  integration (decision 0007) is intentionally deferred until decision 0008 lands. Timer tests use
  real short durations and stop scripts before polling persisted state, so they do not depend on
  log timing; the agent suite runs files sequentially.

- **Project sharing** is verified only against wrangler's local Artifacts simulator
  (`packages/shares-api/scripts/shares-dev`, `BALLAST_SHARES=<bridge url>`). Deploy
  the cloud (it now also deploys the `SharesApi` Worker and its D1) and check the
  service binding, the Artifacts binding (`repo.raw` reads on Alchemy beta.84), token auth and
  isomorphic-git push/fetch against real Artifacts. Subscribed code runs without a sandbox;
  there is no share delete, history UI or rollback yet.

## 7. Next tasks

1. **UI half of W5**: project header/units/source tree/unit logs against the new protocol; the
   service and mock already emit `ProjectSummary`/`ProjectDetail`, units, file reads, project
   params/consent, unit filters and `project-changed`/`reload-failed`.
2. **Real-world driver validation**: OBS scene switch, VTS hotkey + Allow dialog, Twitch local and
   cloud, MIDI controller, keyboard Accessibility, local/cloud webhooks. Record results and fix
   protocol/edge cases.
2. **Surface new states in the web UI**: Accessibility approval with a
   `window.ballast.permissions.requestAccessibility()` button, VTS approval copy,
   `script-source-changed` refetch, and the durable-timer list/countdown/cancel plus
   `timer-fired` event (the protocol and service APIs exist).
3. **Windows + release packaging**: run the desktop lifecycle on Windows, add icon/signing and a
   real electron-updater feed, then exercise app-update quiesce/rollback.
4. **Cloud end-to-end**: deploy the Worker, pair a real machine, run a Twitch EventSub and a webhook
   through the relay, and verify reconnects/revocations.
5. **Harden**: keychain secrets, file-watch source events, stale-event defaults, and script
   isolation before distributing third-party scripts.

## 8. Key files

- `docs/PLAN.md` — product/architecture plan and phases.
- `docs/decisions/0001`–`0005` — the decision record (0001 superseded).
- `apps/agent/src/service/` — service, RPC, connections, scripts, timers, HTTP/auth, lifecycle.
- `apps/desktop/src/main/service/` — launcher (spawn/adopt/replace/stop), stage, registration, process, controls.
- `apps/agent/src/service/background.ts` — CLI background spawn/stop.
- `apps/desktop/src/bridge.ts` — the renderer contract (`service.*`, `permissions.*`, `update.*`).
- `apps/desktop/e2e/desktop.spec.ts` — the real Electron + service lifecycle E2E.
- `packages/agent-protocol/src/` — RPC/schema/event source of truth.
