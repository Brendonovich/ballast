# Ballast: handoff

*Last updated 2026-11-23. Status: **local agent + desktop shell work end to end**. The real
`apps/agent` service is staged by the desktop dev/pack scripts, the Electron shell installs and
supervises it, and the Playwright E2E proves install → fake-tick script → UI → quit UI with the
service still running → uninstall with no LaunchAgent or process left. Phase 1 drivers (OBS,
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
  serves the Solid UI at `/`, `/health` for supervisors, and typed Effect RPC at `/rpc`.
  `ShutdownService` exits 0; `RestartService` exits 75 for launchd/Task Scheduler.
- **Desktop shell.** One Electron window (token → HttpOnly cookie), tray/menu, versioned service
  staging, macOS LaunchAgent / Windows Scheduled Task generation, handoff/rollback, update quiesce,
  and a typed `window.ballast` bridge. Quitting the UI does not stop the service.
- **Integrations.** OBS WebSocket, Twitch (local-app + cloud modes, EventSub, Helix), VTube Studio
  (plugin auth/events/hotkeys), keyboard (libuiohook), MIDI, WebSocket client/server, HTTP client
  and generic local/cloud webhooks. The fake integration drives the E2E and unit suites.
- **Durable timers.** Scripts declare `Ballast.Timer`, schedule with `after(key, duration, payload)`
  and handle fires as events. The service persists one `<project>/.ballast/timers.json` per project
  (atomic 0600, per-project writes, corrupt-file quarantine), validates schedules against the
  applied manifest/fingerprint, applies the late policy, delivers once to the active generation,
  and keeps pending entries through stop/restart. Timer identity is project + timer name + key;
  the script id remains metadata so decision 0008's one-bundle project can reuse the store.
  `ballast run` keeps an in-memory timer store.
- **Cloud.** Cloudflare Worker/Alchemy app for OAuth, Twitch EventSub and webhook ingress, machine
  pairing/relay, and a per-machine RPC link. It typechecks and has protocol/unit tests; a deployed
  end-to-end run is still a next task.
- **Verification.** `pnpm typecheck` and `pnpm test` pass across the workspace. The agent suite
  passes 43/43 (including the timer restart/late/drop/corrupt/project-removal and generation-swap
  cases). The desktop E2E
  (`pnpm --filter @ballast/desktop test:e2e`) passes on macOS against the real service and a
  throwaway LaunchAgent label. The black-box cloud suite (`packages/e2e`, run under fnm 24.22.2)
  passes Twitch cloud mode (pairing, signed EventSub delivery to a worker, relay buffering/replay,
  owner-keyed reconcile) and cloud webhooks; its local-app/Twitch-CLI scenario is skipped because
  Twitch CLI's mock API is not a drop-in Helix/OAuth server.

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| 0001 | Alchemy as the script framework (Plan/Binding/RuntimeContext shape) | **Superseded by 0004**; kept for history and cloud deployment context |
| 0002 | Twitch auth modes (local-app and cloud) + cloud OAuth vault/EventSub/relay | Implemented; local and cloud paths tested with mocks |
| 0003 | Desktop shell, background agent service and local API (AgentRpcs, `service.json`, `/health`, LaunchAgent/Task, staging/handoff, quit-UI vs stop-service) | Implemented; E2E covers the macOS lifecycle |
| 0004 | Drop Alchemy from the script runtime; Ballast plan/runtime layers, Effect only in core | Implemented |
| 0005 | Generic webhooks through the cloud relay, plus local webhook transport, verification and limits | Implemented; real provider validation pending |
| 0006 | Durable timers as declared, schema-typed events persisted per project; no resumable `sleep` | Core, planner and service integration implemented and tested; recurring/cron remains future work |
| 0007 | Effect workflows with a durable engine | Deferred: service integration was canceled for the decision 0008 project-model redesign; the `packages/workflow` prototype stays with its own workstream |
| 0008 | Project = one bundle with an explicit `ballast.ts` entry and named declarations | In progress by another workstream; timer identity is already project-scoped |

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
| `packages/integrations/http` | HTTP client, local webhook server, cloud relay adapter |
| `packages/e2e` | Cross-package protocol tests (no product UI) |
| `apps/agent` | `ballast` CLI + `ballast serve` service + `dist-service` build |
| `apps/web` | Solid web UI served by the agent (scripts, source, logs, connections, settings) |
| `apps/desktop` | Electron shell: launcher, LaunchAgent/Task, tray, bridge, updater |
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
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts projects add ./examples --name Examples

# Web UI (Vite, mocked/live store) or through the service
pnpm --filter @ballast/web dev
pnpm --filter @ballast/web build

# Desktop (builds web + agent dist-service, then Electron)
pnpm --filter @ballast/desktop dev
BALLAST_UI_URL=http://localhost:5173 pnpm --filter @ballast/desktop dev

# Real Electron E2E: real service, throwaway LaunchAgent, real UI + screenshot
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

The desktop service build is `apps/agent/scripts/build-service.mjs`; the desktop helper runs
`apps/web` build first. `BALLAST_SERVICE_BUILD_DIR` overrides the source and
`BALLAST_SERVICE_SKIP_BUILD=1` reuses an existing `dist-service`.

## 5. Open questions

1. **Secrets storage.** Connections/secrets are currently 0600 JSON under `BALLAST_DATA_DIR`.
   Decide when to move to a keychain/credential manager and how headless Linux behaves.
2. **Twitch delivery at scale.** Per-user EventSub subscriptions vs a conduit; check cost/limits
   before relying on cloud Twitch for many machines.
3. **Stale event defaults.** Draft `maxAgeMs` (60 s) and relay retention (24 h) need product
   decisions, especially for webhooks and Twitch.
4. **Script isolation.** `worker_threads` is not a security boundary. Decide on disabling Node
   built-ins/using isolates before distributing scripts written by others.
5. **Windows support.** Generate/build/test the Scheduled Task path on a real Windows machine,
   including the VBS exit-code propagation and launch-at-login.
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
- **Windows** task/wrapper generation is unit-tested only; the E2E is macOS-only.
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

## 7. Next tasks

1. **Real-world driver validation**: OBS scene switch, VTS hotkey + Allow dialog, Twitch local and
   cloud, MIDI controller, keyboard Accessibility, local/cloud webhooks. Record results and fix
   protocol/edge cases.
2. **Surface new states in the web UI**: Accessibility approval with a
   `window.ballast.permissions.requestAccessibility()` button, VTS approval copy,
   `script-source-changed` refetch, and the durable-timer list/countdown/cancel plus
   `timer-fired` event (the protocol and service APIs exist).
3. **Windows + release packaging**: run the Scheduled Task path on Windows, add icon/signing and a
   real electron-updater feed, then exercise app-update quiesce/rollback.
4. **Cloud end-to-end**: deploy the Worker, pair a real machine, run a Twitch EventSub and a webhook
   through the relay, and verify reconnects/revocations.
5. **Harden**: keychain secrets, file-watch source events, stale-event defaults, and script
   isolation before distributing third-party scripts.

## 8. Key files

- `docs/PLAN.md` — product/architecture plan and phases.
- `docs/decisions/0001`–`0005` — the decision record (0001 superseded).
- `apps/agent/src/service/` — service, RPC, connections, scripts, timers, HTTP/auth, lifecycle.
- `apps/desktop/src/main/service/` — launcher, stage/handoff, LaunchAgent/Windows task, controls.
- `apps/desktop/src/bridge.ts` — the renderer contract (`service.*`, `permissions.*`, `update.*`).
- `apps/desktop/e2e/desktop.spec.ts` — the real Electron/LaunchAgent E2E.
- `packages/agent-protocol/src/` — RPC/schema/event source of truth.
