# 0003 — Desktop shell, agent service and the local API

*Status: accepted for Phase 1 (v1 desktop) · 2026-11-22, revised 2026-11-23 · effect `4.0.6` ·
Electron `44.9.1` as shipped by OpenCode Desktop · Rune `dev@e501fe1a` inspected, no releases*

> **2026-11-23: no OS supervisor.** The macOS LaunchAgent / Windows Scheduled Task (and any login
> item) were dropped. Like OpenCode's background service, the desktop app and the CLI spawn
> `ballast serve` as a plain detached process that outlives them. Configuring launchd and Task
> Scheduler (plists, VBS wrappers, exit-code propagation, restart throttling) was too much
> complexity for what it bought. The sections below describe the current model.

## Context

`docs/PLAN.md` and D8 say the desktop shell is **Rune + CEF**, the same approach as the
"OpenCode Desktop rewrite", with Electron as the fallback. The current repo has only a CLI
(`apps/agent`): `ballast plan` and `ballast run` evaluate **one** script in-process, with one
`worker_threads` generation per reload and connection configuration passed as flags. The product
needs a different shape:

- one long-running, per-user **background service** that owns many scripts, connections, cloud
  pairing, params, consent, logs and event history;
- a **desktop app** that ships and starts that service, stays in the tray when the window
  closes, and updates itself;
- a **web UI** for Connections, Cloud, Scripts (manifest/params/logs/events) and Settings;
- one **local API** that the UI, the CLI and (later) MCP and other tools share.

This record decides the shell, the service process/packaging model, discovery and security, the
UI stack, and the v1 screen scope. Editing is deliberately out of scope; scripts are managed by
files/agents and viewed here. Graphs are also out of scope, but the script view model leaves a
typed place for them.

### Method and repo state

| Source | Revision inspected | Note |
|---|---|---|
| `~/github.com/anomalyco/rune` | `e501fe1a` (`dev`) | `git pull --ff-only` **refused**: `dev` is 181 ahead and 2,629 behind `origin/dev`; local work would be lost. Read as-is. `CHANGELOG.md`: "Rune has no releases yet; consumers pin `dev` revs." |
| `~/github.com/anomalyco/rune-desktop` | `9d054895` (`main`) | `git pull` failed: local `main` tracks `refs/heads/main`, which the remote no longer fetches (remote HEAD is `dev`). Read as-is. |
| `~/github.com/anomalyco/opencode` | `nearby-pairing` worktree | OpenCode Desktop `packages/desktop` at 2.2.7 (Electron 44.9.1). Used as the shipped-service reference. |
| `~/github.com/brendonovich/cf-effect-experiment` | local worktree | MacroGraph v2 UI stack reference. |
| Installed `effect@4.0.6` | `node_modules/effect/src/rpc` | RPC API and test harness read from source, not memory. |

Claims marked **[repo]**, **[source]** (installed Effect), **[measured]**, **[docs]** or
**[shipped artifact]**.

### Decisions confirmed by review (2026-11-23)

| Question | Decision |
|---|---|
| Shell | Electron for v1; Rune + CEF deferred until the triggers in §1. |
| Service lifetime | Independent of the Electron app. The app (or CLI) spawns `ballast serve` as a detached process, run with the app binary and `ELECTRON_RUN_AS_NODE=1`; quitting the UI does not stop the service. No OS supervisor and no start at login: the service starts when the app or CLI is opened. Explicit stop/restart from tray, UI and CLI. |
| Updates | Service stages are versioned and never overwritten; on launch the app replaces a running service of another version (stop → spawn new stage → verify), and respawns the previous stage on failure. |
| Secrets | `0600` file in v1 (`secrets.json`); OS keychain later. |
| Logs/events | In-memory ring buffers only in v1. |
| New scripts | Always stop and wait for an explicit Start, even with no new permissions. `enabled: true` (set by Start) means resume after a service restart; Stop sets it false. |
| Projects | Many per service. Scripts/params/consent are per project; connections and cloud pairing are service-wide (one OBS/Twitch account shared by all projects). |
| Connection scope | Service-wide, keyed by `(integration, slot)`; `usedBy` lists `(projectId, scriptId)`. A project needing another instance uses another slot. |

---

## 1. Shell: Electron for v1, Rune + CEF only after it closes named gaps

### The options against the requirements

| Requirement | Rune + CEF (D8) | Electron | Tauri 2 |
|---|---|---|---|
| Maturity | **No releases**, consumers pin `dev`; M0.5/M1 in `PLAN.md`; flagship test is still "recreate OpenCode Desktop" **[repo]** | 44.x, used by the shipping OpenCode Desktop 2.2.7 **[repo]** | v2 stable; updater/autostart/tray are supported plugins **[docs]** |
| Web UI hosting | CEF 156 sidecar, separate download and trust pipeline **[repo]** | Chromium built in | OS WebView (WKWebView/WebView2/WebKitGTK) **[docs]** |
| macOS + Windows | Browser engine has both paths: AF_UNIX on Windows (`uds_windows`), D3D11 shared textures; IOSurface/Mach ports on macOS **[repo]** | First-class; OpenCode ships macOS + Windows + Linux installers **[repo]** | First-class |
| Node for the agent | Must ship Node separately; Rune is Rust | Electron's Node can run the service with `ELECTRON_RUN_AS_NODE=1`; 112 MB runtime already in the app **[measured]** | Must ship Node separately; shell is Rust |
| Tray / menu-bar item | Rune has `App::accessory()` and `keep_running()`, but **no tray/status-item API**; the app must call AppKit/Win32 itself **[repo]** | `Tray` built in **[source: electron.d.ts]** | `TrayIcon` built in **[docs]** |
| Login item / autostart | **No API found** (no `SMAppService`, `LoginItem`, `autostart`, `LaunchAgent` in `crates/`) **[repo]** | `app.setLoginItemSettings({ openAtLogin })` built in **[source: electron.d.ts]** | `tauri-plugin-autostart` **[docs]** |
| Notifications | No notification API found **[repo]** | `Notification` built in | `tauri-plugin-notification` |
| Auto-update | No updater in Rune; rune-desktop has a bespoke updater per platform (`apps/desktop/src/updater`, mac signature verification, Windows SHA-256 + Authenticode) **[repo]** | `electron-updater` 6.8.9 + electron-builder 26.15.7, generic feed, used by OpenCode Desktop **[repo]** | `tauri-plugin-updater`, signed JSON, `passive`/`quiet` Windows install modes **[docs]** |
| Packaging / signing | `build-app.sh` ad-hoc signs, CI adds Developer ID + notarization; Windows `apps/installer` + Authenticode; browser engine has its own download/unpack/upgrade path **[repo]** | electron-builder; OpenCode has macOS notarization + Windows signing + NSIS **[repo]** | Bundler; signing/notarization still project work |
| Install size | Rune binary small, but CEF engine downloads **128 MB (macOS) / 142 MB (Windows)** on first browser use **[repo]**, and the UI still needs a browser or a Rust rewrite | **655 MB** for OpenCode Beta.app: 276 MB Frameworks + 203 MB app.asar + 174 MB bundled CLI **[measured]** | Shell is typically single-digit MB (system WebView), plus **112 MB** Node if the agent ships Node **[measured: local node]** |
| Linux | Browser engine has **no source configured** for Linux (`DEV_SOURCE`/`TRUST` empty outside macOS/Windows) **[repo]** | Supported | Supported |

### What rune-desktop actually is

`rune-desktop` is the reference for Rune apps, and it is **a native client, not a service host**:

- `README.md`: "OpenCode (Rune) discovers `http://127.0.0.1:4096` or `~/.config/opencode/service.json`
  automatically ... and **never starts a server on its own**." **[repo]**
- `crates/opencode-kit/src/local_service.rs` parses `service.json` (`url` + `password`) under XDG
  state (or `service-local.json` for Desktop's local channel), then probes and adopts it. That is
  the discovery pattern to copy, not a supervision implementation. **[repo]**
- `crates/browser-pane` is a Chromium pane for pages (docs, links, web tools), not the app's UI
  toolkit: it connects to an out-of-process CEF engine over a Unix socket, streams frames, and
  ships a separate engine download. `apps/browser-engine/src/main.rs` confirms Windows support
  (`AF_UNIX` via `uds_windows`, D3D11 shared textures, `windows_subsystem = "windows"`), so the
  Windows question in HANDOFF §4 is answered: it works, but it is a second product with its own
  installer and updater. The release workflow builds Windows x64 four times a day, so Windows
  support is real; the problem is the missing shell/service features below, not Windows. **[repo]**
- The app's own OS integration (tray, updater, signing, login item) is hand-written in
  `apps/desktop`, not provided by Rune.

So D8's comparison is not quite "Rune vs Electron for the same thing": the Rune rewrite is a
native client for a server that already exists. Ballast needs the **server** too, and the shell
requirements (tray, login item, notifications, updater) are exactly the parts Rune does not yet
provide.

### How OpenCode Desktop ships its background server (the pattern to copy)

OpenCode Desktop is Electron + SolidJS. From `packages/desktop`:

- The CLI is a separate executable in `resources/opencode-cli`, **outside `app.asar`**
  (`electron-builder.config.ts` `extraResources`), so it can be spawned as a process. **[repo]**
- `src/main/service/desktop-cli.ts` resolves the bundled CLI, compares its version against a
  shipped `opencode-cli.version` file (avoiding a 200 MB `--version` spawn on the startup path),
  and stages/copies it into the user's install. **[repo]**
- `src/main/service/background-service.ts` calls
  `setup.client.Service.ensure({ command: [...cli.command, "serve", "--service"] })` and adopts a
  service found through `service.json`; `BackgroundServiceMachine` is an explicit state machine for
  connect / verify / reconnect / failure, and `SidecarCredentials` is broadcast to every window so
  all requests move to the new origin together. **[repo]**
- `electron-updater` with a generic feed updates the app in place; the staged CLI is cleaned on
  the next launch, keeping the running version's stage. **[repo]**
- Measured `OpenCode Beta.app`: 655 MB total. This is the real cost of the Electron choice; the
  Ballast app can be smaller because it has no 174 MB compiled CLI and a smaller renderer. **[measured]**

### Decision

**Electron is the v1 shell. Rune + CEF is deferred, not rejected.** The UI is a web app served by
the agent service, so the shell is replaceable.

Why not Rune now:

1. **The shell APIs Ballast needs do not exist yet.** Rune has no tray/status item, login item,
   notification or updater API. Building them is framework work, and it is on the critical path
   (tray is a v1 requirement, not later polish).
2. **CEF is a separate downloaded product.** A 128–142 MB engine with a trust/unpack/update
   pipeline, no Linux source, and a pane abstraction designed for browsing. Using it as the UI
   host means shipping the same web UI *plus* the sidecar lifecycle.
3. **rune-desktop does not supervise a service**, so it gives no evidence for the part we most
   need; OpenCode Desktop does, and it is Electron.
4. **The UI would still be web or Rust.** If it is web (the author's stack), Rune adds shell risk
   without reducing UI work. If it is Rust, we lose the SolidJS ecosystem and the existing
   MacroGraph UI experience for no v1 gain.

### Fallback triggers

| Trigger | Action |
|---|---|
| Rune ships a release with tray/status item, login item, notifications and updater APIs, **and** a Rune app ships a bundled CEF engine (no first-run download) on macOS + Windows | Run a 2-week shell spike; port the Electron shell. The service API and UI stay unchanged. |
| Electron installer size or memory becomes a hard product constraint, or Windows WebView2 policy blocks Electron | Move the shell to Tauri 2; keep the same service + web UI. Tauri's updater/autostart/tray plugins cover the shell needs. |
| A required agent native module cannot load in Electron's Node (N-API should prevent this) | Ship stock Node as the service runtime (112 MB) instead of `ELECTRON_RUN_AS_NODE`; no protocol changes. |
| Electron signing/notarization or `electron-updater` fails on Windows in the release spike | Tauri 2 becomes primary; do not hand-roll an updater. |

The shell owns only: window, tray, menu, update, service discovery/spawn/stop, OS dialogs and
keychain access. It holds no product state. The UI always loads from the service
origin and speaks the RPC group, so a future Rune/Tauri shell is a shell-only change.

---

## 2. The background service

### Process model

```
Electron main (tray, updates)
  │  reads service.json; spawns/replaces/adopts/stops
  ▼
ballast-agent service (one per user, independent of the UI; Node via ELECTRON_RUN_AS_NODE)
  ├─ HTTP + WebSocket on 127.0.0.1:<random>   (UI, CLI, MCP later)
  ├─ ProjectManager ── many projects (folders of scripts), independent state
  ├─ ScriptManager ── one worker_threads generation per script
  ├─ ConnectionManager ── one driver per configured connection (OBS, Twitch, fake…)
  ├─ CloudLink ── pairing, relay, token requests
  ├─ ProjectStore ── per-project settings, applied manifests, params, consent
  └─ Log/Event ring buffers ── snapshots + live streams
```

- **Service entry:** `ballast serve` runs until shutdown. It owns the projects and is the only
  process that writes script state or opens connections. `ballast plan`/`run` remain for
  development against a single file (see §5).
- **One service per user, many projects.** Each project is a folder with `scripts/*.ts` and a
  `.ballast/` state directory. Projects are added/removed at runtime (`AddProject(path)` /
  `RemoveProject`); removing a project never deletes its files. Script identity is
  `(projectId, scriptId)`, because two projects may both contain `scripts/tick-echo.ts`.
- **Connections are service-wide, not per project.** One OBS, one Twitch account and one cloud
  pairing serve every project. This is deliberate:
  - the physical resources are machine-level (one OBS WebSocket, one OAuth refresh token), and
    per-project copies would open duplicate sockets and duplicate provider subscriptions;
  - a streamer with a main and a second channel expects both projects to use the same OBS and the
    same broadcaster account;
  - cloud pairing and the machine relay are per-machine by design (decision 0002).
  Script slots remain project-local names (`obs/main`, `twitch/broadcaster`); a project that needs
  a different OBS instance uses a different slot (`obs/secondary`), still shared by any project
  that binds it. `ConnectionSummary.usedBy` lists the `(projectId, scriptId)` pairs so the UI can
  show which projects a connection serves.
- **Scripts run in workers**, one `worker_threads` worker per generation, as Phase 0 does. The
  service can run many scripts across projects concurrently; replacing a script terminates only
  its old worker.
- **New scripts never auto-start.** A discovered script starts with `enabled: false` and
  `status: "stopped"`, even when its plan needs no new permissions. Start (or
  `SetScriptEnabled(true)`) is the explicit user action that applies the plan and starts a
  generation. `enabled` means “start this after a service restart”. `StartScript` sets it true;
  `StopScript` sets it false; `SetScriptEnabled` changes it explicitly (enabling starts it after
  consent, disabling stops it). On service start, only scripts with `enabled: true` are resumed;
  if a resumed plan now needs consent, the script shows `needs-consent` and stays stopped.
- **Connections are shared, not per script.** A single `ConnectionManager` owns one driver per
  `(integration, slot)` and publishes envelopes into a shared bus. This differs from today's CLI
  (each `runScript` starts its own OBS driver): two scripts using `obs/main` must not open two OBS
  WebSockets or receive duplicate events. The manifest's topic subscriptions become bus filters;
  the driver is reference-counted by the union of running manifests.
- **CloudLink** is the single outbound machine WebSocket from decision 0002. Twitch cloud mode is
  a connection transport over it; local-app mode keeps its own EventSub socket and token refresh.
- **The service lifecycle is independent of the Electron app.** Closing the window or quitting
  the UI does not stop the service. There is no OS supervisor (no LaunchAgent, Scheduled Task or
  login item); the shell and the CLI start it as a plain detached process, as OpenCode does:

  | Started by | How | Stop / restart |
  |---|---|---|
  | Desktop app (every launch) | `spawn(<electron>, [<userData>/service/<version>/main.mjs, "serve"], { detached: true, stdio: [ignore, service.log, service.err.log], windowsHide: true })` with `ELECTRON_RUN_AS_NODE=1`, then `unref()` | Tray/Settings: `ShutdownService` → wait for exit → `SIGTERM` → `SIGKILL`; restart = stop + spawn |
  | CLI | `ballast service start` (or any service command when none is running) re-runs its own runtime + entry with `serve`, detached the same way | `ballast service stop` / `restart`, same sequence |
  | Dev | `ballast serve` in a terminal; `--supervised` exits when the parent closes stdin | Ctrl-C / explicit RPC |

  The service has no idle exit and keeps running until stopped, logout or reboot. There is no
  start at login: the service starts when the app or CLI is next opened. `BALLAST_AUTOSTART=0`
  stops the app from starting it on launch (tests).
- **Every app launch calls `start()`.** Adopt a running service of the shipped version; replace a
  running service of any other version (stop → spawn the new stage → verify `/health` version →
  clean old stages; on failure respawn the previous stage = rollback); otherwise spawn.
- **Explicit stop/restart everywhere.** Tray, UI Settings and CLI all stop through
  `ShutdownService` (exit 0) with `SIGTERM`/`SIGKILL` fallbacks; restart is stop + spawn by the
  caller, so a browser-only UI can stop but not restart. CLI: `ballast service
  start|stop|restart|status`. Quitting the UI is separate from stopping Ballast: the tray menu
  offers “Quit Ballast UI” (service stays) and “Stop Ballast” (explicit stop).
- **No OS system service / admin daemon.** Everything is per-user: no admin, no session-0
  service. That matches streamers' desktop tools and keeps OBS access in the user session.

### Packaging the service

**v1: ship a JS bundle directory and run it with Electron's Node
(`ELECTRON_RUN_AS_NODE=1`). Not Node SEA, not `bun build --compile`.**

Why:

- The agent uses `worker_threads` with real file paths: `packages/planner/src/plan-worker-client.ts`
  creates `new Worker(new URL("./plan-worker.ts", import.meta.url))`, and
  `apps/agent/src/runtime-session.ts` creates a worker from a rolldown bundle written at runtime.
  A single-file SEA cannot load modules from the file system in its injected main script; Node's
  docs say module loading reads no files and `import()` of file modules throws. Worker entrypoints
  would need the VFS/asset workaround (Node 26.9+ only), and native addons still need a temp file.
  SEA is also Stability 1.1 and macOS x64 is not in its tested matrix. **[docs: Node SEA]**
- `rolldown` is a native N-API addon (`@rolldown/binding-*`). N-API works in Electron, but SEA
  would have to extract and `dlopen` it manually. Bun's `--compile` support for
  `worker_threads` + N-API native addons is unproven for this workload; do not put the product on
  it without a spike.
- Electron already contains a Node runtime. Using `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1` avoids a second 112 MB runtime and keeps the service on the Node
  version the app was tested with. The service is still a separate process, so closing the window
  does not stop it.
- If a dependency later proves incompatible with Electron's Node, switch to a pinned stock Node
  runtime; the service build is the same directory of JS.

The service build is a directory, not a single file:

```
resources/service/<version>/
  main.mjs               # `ballast serve` entry
  plan-worker.mjs        # new Worker(new URL(...)) target
  web/                   # built Solid UI (index.html + assets)
  node_modules/          # only if a native/optional dep cannot be bundled
```

Rolldown must emit stable chunks (`codeSplitting: true`, fixed entry names) so
`new URL("./plan-worker.mjs", import.meta.url)` works from `main.mjs`. Script runtime bundles are
still generated per generation into a temp directory (as today), so they are unaffected.

**Staging and updates.** The app carries `resources/service/<version>`; on first run it copies the
tree to `<userData>/service/<version>`; the service writes `service.json`. The running service
keeps its version on disk; the app cleans old stages on launch, keeping the running one (the
opencode `cleanStages` pattern). The service runs from the **stage path**, not from the app's
resources, so an app update never mutates a running service. Development builds get a
content-hashed version, so a rebuilt service is a new stage and `dev` replaces the running one.

App update:

1. Stage the new `service/<newVersion>` and UI. Do not delete the old stage.
2. **Quiesce the service before replacing the app binary.** Windows locks a running `.exe`, and
   electron-updater replaces the macOS bundle too, so the service cannot keep running while the
   app is replaced. `prepareForAppUpdate()` stops it (`ShutdownService`, wait for exit), then
   electron-updater installs. This is the one planned pause; scripts resume from `enabled` state
   when the new service starts.
3. The relaunched app's `start()` finds no service (or one of another version), spawns the new
   stage and verifies `/health` reports the expected `version`. The old stage stays on disk until
   then.
4. If the new service fails to start, respawn the previous stage and surface the error.

For a future hot update (no app binary replacement), the same staging/replace works without step
2: stage the JS, stop, spawn the new stage, verify, roll back. The app update path
does not promise zero downtime; it promises that state is on disk, scripts resume, and a failed
update rolls back to the previous stage. If zero-downtime app updates become a hard requirement,
stage a private copy of the Electron runtime (~276 MB) in the service stage so the app bundle can
be replaced while it runs; that is explicitly not v1.

`service.json` is removed on graceful exit. A crash leaves it; the shell adopts a registration
only when `/health` answers with the same pid.

### Discovery: `service.json`

The service binds `127.0.0.1:0` (random free port; `BALLAST_SERVICE_PORT` for development) and
writes an atomically replaced registration file with mode `0600` in a `0700` directory:

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "name": "ballast-agent",
  "version": "0.1.0-dev.20261122",
  "url": "http://127.0.0.1:53124",
  "token": "3f9c…64-char-base64url",
  "pid": 4242,
  "defaultProjectId": "proj_main",
  "startedAt": 1764000000000
}
```

Locations, in discovery order for CLI/other clients:

1. `BALLAST_SERVICE_URL` + `BALLAST_SERVICE_TOKEN` (tests, remote debugging).
2. `<state>/ballast/service.json`, where `<state>` is `XDG_STATE_HOME`, else
   `~/.local/state` (macOS/Linux); on Windows `%LOCALAPPDATA%\Ballast\state\service.json`.
3. `<data>/ballast/service.json` for older installs (`XDG_DATA_HOME`, else
   `~/.local/share`; Windows `%LOCALAPPDATA%\Ballast`), matching the existing
   `resolveDataDir()` in `apps/agent/src/twitch/config.ts`.

This mirrors the opencode-kit rule: clients look in state, then config/data, and validate the
`url` is loopback before using it. The Electron shell reads the same file and checks
`GetServiceInfo.apiVersion` before adopting a running service.

A `<state>/ballast/service.lock` contains `{ pid, startedAt }` and is created exclusively
(`wx`). A live lock pid means the service is running or still starting (`service.json` is only
written after warm-up), so a second `serve` refuses. Only a dead pid, or a live pid that never
registered within 5 minutes (pid reuse), is stale and replaced. On exit the service removes
`service.json`/`service.lock` only if they still name its own pid. Only one service may own this
user's state. Removing `service.json` while the service runs is
harmless; the next client just cannot discover it until restart.

### Local API transport

- **HTTP + WebSocket** on `127.0.0.1`. The RPC group is served at `/rpc` with Effect RPC over
  WebSocket (`RpcServer.layerHttp({ group, path: "/rpc", protocol: "websocket" })` +
  `RpcSerialization.layerJson` + `NodeHttpServer`), so one connection carries all request/response
  and streaming RPCs. `WatchService`, `StreamLogs` and `StreamEvents` are ordinary streaming RPCs.
- `GET /health` is a small unauthenticated JSON endpoint for the shell/CLI (pid, version,
  apiVersion, uptime). It exposes no project data.
- `GET /` serves the built UI (`HttpStaticServer`/`HttpServerResponse.file`), including a
  `Referrer-Policy: no-referrer` header.
- The CLI and MCP use the same client generated from `AgentRpcs`; the UI's transport is the same
  client over a browser WebSocket.

### Security

| Concern | Rule |
|---|---|
| Network exposure | Bind **explicitly** to `127.0.0.1`; never `0.0.0.0` or `::`. The port is random by default. |
| Authentication | Per-run 32-byte token in `service.json` (`0600`), compared in constant time. CLI/MCP send `Authorization: Bearer <token>`. |
| Browser session | The shell loads `http://127.0.0.1:<port>/?token=<token>`; the service validates it, sets an `HttpOnly; SameSite=Strict; Path=/` session cookie, and redirects to `/`. The token never appears in the UI or in JS. |
| Authorization | All RPCs require the bearer token or session cookie. `/health` is the only unauthenticated endpoint. |
| DNS rebinding / CSRF | Check `Host` is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`. Reject foreign `Origin` on WebSocket upgrades and state-changing HTTP requests. No CORS by default; no `Access-Control-Allow-Origin: *`. |
| Dev UI | Only with `--dev`, allow `http://localhost:5173` (Vite) as an origin and a `BALLAST_DEV_TOKEN`; never in a packaged build. |
| Secrets | `service.json`, `service.lock` and connection secrets are `0600` in a `0700` directory. v1 stores connection secrets in `<data>/ballast/secrets.json` (as the Twitch code already does); Phase 2 moves them to the OS keychain. Cloud machine tokens are stored the same way. |
| Logging | Redact the token, `Authorization`, cookie and secret fields from logs and error details. `service.json` is never copied into logs or telemetry. |
| Shutdown | `ShutdownService` requires auth. Stop closes workers, drivers and the cloud socket, removes `service.json` and always exits 0. The caller waits for exit, then `SIGTERM`, then `SIGKILL`. Restart is stop + spawn by the caller; there is no restart RPC. |

The service watches its parent only in `--supervised` mode (stdin EOF = parent died; dev and
tests); it then exits rather than orphaning a second writer. The normal detached service ignores
its parent.

### CLI

The CLI becomes a client of the same service:

```
ballast serve [--port 0] [--dev] [--supervised]
ballast status
ballast projects list|get|add <path>|remove <id>
ballast scripts list|get|start|stop|restart|logs|events [--project <id>]
ballast connections list|configure|connect|disconnect|auth
ballast pair [--code <code>]
ballast service start|stop|restart|status
ballast doctor                      # discovery, apiVersion, health
ballast plan <entry> [--in-process]  # dev: current behaviour
ballast run <entry> [--in-process]   # dev: current behaviour
```

`plan`/`run` keep their current in-process implementation for developing the script engine and
for CI. Their output prints a warning that they bypass the service. Everything else uses the
generated `AgentClient`; discovery is §2's, with the env overrides for tests. Commands that need
the service start it in the background when none is running (not `ballast status`, and not when
`BALLAST_SERVICE_URL` is set). MCP will be another
client of the same API, with its own scoped token later.

### State, logs and events (v1)

| Data | Where | Retention |
|---|---|---|
| Project roots | Registered in `<data>/ballast/projects.json`; scripts stay in the user's folder | — |
| Per-project settings, enabled flags, params, applied manifests, pending consent | `<project>/.ballast/settings.json`, `<project>/.ballast/applied/<script>.json` | — |
| Connection config and secrets (service-wide) | `<data>/ballast/connections.json` + `secrets.json` (0600) | — |
| Cloud pairing (per machine/service) | `<data>/ballast/cloud.json` (existing) | — |
| Logs | In-memory ring buffer (2,000 lines global, plus per-project/per-script views) | Current service run |
| Events | In-memory ring buffer (2,000 envelopes, inbound + outbound) | Current service run |
| SQLite project store | Later (Phase 2/3), when state/history need queries and crash safety | — |

A JSON file per project is enough for v1: a few scripts, small manifests. The store is behind a
`ProjectStore` service so SQLite can replace it without touching ProjectManager, ScriptManager or
the protocol. Logs and events are reseeded by a fresh snapshot on reconnect; after a service
restart the buffers start empty (the UI shows that clearly).

---

## 3. UI stack and v1 screens

### Stack: SolidJS + Vite + TypeScript

Confirmed from the repos:

- MacroGraph (`cf-effect-experiment`) uses `solid-js@2.0.0-rc.9` / `@solidjs/web@2.0.0-rc.9` /
  `@solidjs/router` across `apps/cloud/frontend`, `packages/editor-ui` and every module UI.
- OpenCode Desktop uses `solid-js` + `@solidjs/router` (1.x) + Vite with Electron, and
  `@kobalte/core` for accessible primitives.
- rune-desktop does not use Solid: it is Rust + Rune views (and a wasm web build). That is a
  different UI stack, another reason not to choose it for the web UI.

**Decision: SolidJS + Vite + TypeScript, served by the service.** v1 pins Solid 1.x (the OpenCode
Desktop/battle-tested line); if we later reuse MacroGraph's editor components, that subtree can
move to 2.0 RC or we can keep the viewer on 1.x. No UI kit is decided here; `@kobalte/core` and
MacroGraph's `editor-ui` are the candidates when the shell work starts.

**Serving model:** the service serves the built UI at `/`. Electron loads
`http://127.0.0.1:<port>/?token=…`, which sets the session cookie and redirects to `/`. This
means:

- one origin for UI + RPC + WS, so cookies and `Origin` checks are simple;
- the UI and the service always ship together (no version skew between renderer and agent);
- the same URL works in a browser, in a future Rune/Tauri shell, and for manual debugging;
- the shell has a tiny bundled fallback page ("Starting Ballast…" + Retry + Logs) for when the
  service is down; it does not bundle the product UI.

Development: `pnpm --filter @ballast/web dev` runs Vite on `:5173`, proxies `/rpc` and `/health`
to the service, and reads `BALLAST_SERVICE_URL`/`BALLAST_SERVICE_TOKEN` from the environment. The
service allows the Vite origin only with `--dev`.

### v1 screens

Navigation: **Scripts**, **Connections**, **Cloud**, **Settings**, plus a project switcher, a
persistent service status bar and tray menu. The first screen after onboarding is the last used
project's Scripts list. Projects are added from the switcher or Settings.

| Screen | What it shows | Data (RPC) | Actions |
|---|---|---|---|
| **Shell chrome** | Window, tray icon/menu, service health/version, connection-to-service state, update badge | `GetHealth`, `GetServiceInfo`, `WatchService`; Electron updater events | Show/Hide, Start/Restart service, Stop Ballast, Quit UI, Install update |
| **Projects** | List of projects (name, root, script count, running count, last error); add/remove | `ListProjects`, `GetProject`, `WatchService` | `AddProject(path)`, `RemoveProject` (files untouched), switch project |
| **Connections** | Service-wide list grouped by integration, one row per connection (title, slot label, status pill, account/detail, used-by projects/scripts). Detail pane: fields, mode, scopes, last error | `ListConnections`, `GetConnection`, `WatchService` | `ConfigureConnection` (URL/password, Twitch client id/secret), `ConnectConnection`, `DisconnectConnection`, `StartConnectionAuth` (browser/device code), re-auth when `scopes.missing` is non-empty |
| **Cloud** | Link state, Twitch account, machine name/id, relay connected/pending, last event time (one pairing for all projects) | `GetCloudStatus`, `WatchService` | `BeginCloudPairing` (open URL, show code), `PairCloud` (paste code), `UnpairCloud` |
| **Scripts list** | For the selected project (or all): name, status, enabled, generation, last error, updated-at; new scripts marked “Not started — review and start” | `ListScripts({ projectId? })`, `WatchService` | Open; Start/Stop/Restart; Plan; set enabled (resume on restart) |
| **Script detail: Overview** | Manifest: params form, connections (slot → bound service-wide connection + status), topics (scopes, onStale, maxAge, condition), requests (scopes), unresolved warnings | `GetScript({ projectId, scriptId })`, `PlanScript`, `WatchService` | `SetScriptParam`; open the matching connection; Plan |
| **Script detail: Consent** | Banner/modal with the diff: added scopes, connections, topics, requests; which scripts/projects need them | `GetScript.pendingConsent`, `ListConsents({ projectId? })`, `WatchService` | `ApproveConsent`, `RejectConsent` |
| **Script detail: Logs** | Live lines, level filter, script filter, pause, search, timestamps, structured fields | `StreamLogs({ projectId?, scriptId?, afterSeq })`, `WatchService` | Clear view, copy, open raw |
| **Script detail: Events** | Live inspector: inbound/outbound, topic, connection, project/script, time, payload JSON, stale/dropped badges | `StreamEvents({ projectId?, ... })`, `WatchService` | Filter by project/topic/integration; replay is Phase 3 |
| **Script detail: Graph** | Placeholder in v1; renders when `view.kind === "graph"` | `GetScript.view` | none |
| **Settings** | Service running/version/pid/state dir, quit-to-tray, log level, cloud URL (advanced), project roots, copy diagnostics | `GetServiceInfo`, `GetHealth`; desktop bridge `service.status` | Stop service (restart only in the desktop app); open logs/data folders; add/remove project |
| **Onboarding** | Add the first project (folder), connect OBS (optional), sign in to Twitch (optional) | `AddProject`, `GetServiceInfo`, `ConfigureConnection`, `ConnectConnection`, `BeginCloudPairing` | Finish → Scripts |

Notes:

- **New scripts wait for a person.** Discovery plans a script and leaves it stopped with
  `enabled: false`; its list row says why (consent needed or “not started yet”). Starting is
  explicit. Once started, `enabled: true` makes it resume on the next service start.
- **Consent is per project/script.** A pending consent appears in that project's Scripts list, a
  tray notification and the script detail; approving is the only way to start that generation.
  Rejecting leaves the previous applied generation running (or the script stopped if it never ran).
- **Scopes are connection-level and service-wide.** `ConnectionSummary.scopes.required` is the
  union across all enabled scripts in all projects; `missing` drives a "Re-authorize" button with
  the exact scopes and the project/script refs that need them. The service computes this from
  applied manifests, not from the UI.
- **Offline/reconnect.** If the WebSocket drops, the UI keeps the last snapshot, shows
  "Reconnecting…", and on reconnect takes a fresh `WatchService` snapshot and resumes
  `StreamLogs`/`StreamEvents` with `afterSeq`. No lost log lines within the service run.
- **No editing.** There is no file tree, editor or diagnostics in v1. "Open in editor" can hand
  the path to the OS; editing is via files/agents/API.
- **Graph room.** `ScriptDetail.view` is `{ kind: "script" | "graph"; graph?: { nodes, edges } }`.
  The manifest remains the source of truth; a graph is a presentation of the same data. The UI
  switches on `view.kind`, so adding graphs is additive and needs no new RPC for the first cut.

---

## 4. `@ballast/agent-protocol`

Created `packages/agent-protocol` as the transport-independent contract. It depends only on
`effect`; it does not import `@ballast/core`, `apps/agent` or Alchemy, so it stays stable while
the script engine and integrations are in flight.

Modules:

| File | Contents |
|---|---|
| `src/common.ts` | Project/script/connection ids, timestamps, param values, connection mode/status, `AgentError` |
| `src/projects.ts` | `ProjectSummary`, `ProjectDetail`, add/remove payloads |
| `src/service.ts` | `ServiceInfo` (apiVersion, pid, defaultProjectId, platform, capabilities), `HealthStatus` |
| `src/scripts.ts` | `ScriptRef`, `ScriptSummary` (projectId, enabled), `ParamView`, manifest views (params/connections/topics/requests/unresolved), `ManifestDiff`, `ConsentRequest`, `ScriptDetail`, `ScriptView` + reserved `GraphView` |
| `src/connections.ts` | `ConnectionSummary` (fields, redacted values, scopes, account, `usedBy: ScriptRef[]`), configure/connect/auth schemas |
| `src/cloud.ts` | `CloudStatus`, pairing session, `PairCloud` payloads |
| `src/logs.ts` | `LogEntry`, `EventRecord`, project/script stream filters |
| `src/events.ts` | `ServiceSnapshot` and `ServiceEvent` (snapshot, project, script, connection, cloud, consent, health) |
| `src/requests.ts` | Shared payload structs (`{ projectId, scriptId }`, param, enabled, reject consent) |
| `src/rpc.ts` | The `AgentRpcs` group, `AGENT_RPC_PATH`, `AgentClient` type |
| `src/mock.ts` | `MockAgentLayer`/`MockAgentRpcs`: full in-memory implementation with realistic data |
| `test/rpc.test.ts` | In-process client tests through the real Effect RPC machinery |

RPCs: `GetServiceInfo`, `GetHealth`, `ShutdownService`; `ListProjects`,
`GetProject`, `AddProject`, `RemoveProject`; `ListScripts`, `GetScript`, `PlanScript`,
`StartScript`, `StopScript`, `RestartScript`, `SetScriptParam`, `SetScriptEnabled`,
`ListConsents`, `ApproveConsent`, `RejectConsent`; `ListConnections`, `GetConnection`,
`ConfigureConnection`, `ConnectConnection`, `DisconnectConnection`, `StartConnectionAuth`;
`GetCloudStatus`, `BeginCloudPairing`, `PairCloud`, `UnpairCloud`; streaming `StreamLogs`,
`StreamEvents`, `WatchService`.

Design points:

- **Projects are first-class, scripts are project-scoped.** Every script RPC takes
  `{ projectId, scriptId }`; list and stream RPCs take an optional `projectId` filter. The
  snapshot carries projects as well as scripts, connections, cloud and consents.
- **Connections are service-wide.** `ConnectionSummary.usedBy` is a list of
  `{ projectId, scriptId }`, so the UI can show one OBS or Twitch account serving several
  projects. Cloud pairing is per machine/service, not per project.
- **New scripts are stopped with `enabled: false`.** Start/SetScriptEnabled is the explicit user
  action; `enabled` controls resume-after-restart only.
- **Mutations return the new `ScriptDetail`/`ConnectionSummary`/`CloudStatus`.** The UI updates
  immediately and does not race a re-read.
- **Secrets are write-only.** `ConfigureConnection` accepts secret values; `ConnectionSummary`
  reports `{ isSecret: true, isSet: true }` and never the value.
- **Streams start with buffered history, then follow live.** `afterSeq`/`limit` make reconnects
  cheap; `asQueue: true` gives the UI a scoped queue when that is easier than a Stream.
- **`WatchService` sends a full snapshot first.** One subscription drives every list/badge; the
  snapshot also carries `pendingConsents`.
- **The service maps its internal manifest to the wire view at its edge.** `@ballast/core` can
  evolve without breaking the UI contract; the mapping is a pure function with tests.
- **Versioning.** `apiVersion: 1`; additive schemas/optional keys are compatible; new RPC tags
  are compatible; removing/renaming fields or changing semantics bumps `apiVersion`. The shell
  refuses to adopt a service with a different major API version and replaces it.

The mock is deliberately realistic: **two projects** (Main Channel, Second Channel), four scripts
(running, needs-consent, stopped, error), OBS, Twitch cloud/local, fake, cloud linked, logs and
events. It supports every mutation (including project add/remove), publishes
the same `ServiceEvent`s, and is the UI's data source until the service lands.

Verification:

```
pnpm --filter @ballast/agent-protocol typecheck   # tsgo -b, clean
pnpm --filter @ballast/agent-protocol test        # 13 tests, 1 file, passed
pnpm typecheck                                    # workspace clean
pnpm test                                         # all workspace tests passed (agent-protocol 13)
```

---

## 5. Implementation plan: three parallel workstreams

Three agents can work in parallel if they keep to these boundaries. `@ballast/agent-protocol` is
the contract; nobody imports another workstream's source.

### Interfaces between the workstreams

| Boundary | Contract |
|---|---|
| **A (shell + UI) ↔ B (service)** | `AgentRpcs` from `@ballast/agent-protocol`; `service.json` discovery; `/rpc` WebSocket; bearer token/session cookie. A uses `MockAgentLayer` until B answers `/health`. No direct imports from `apps/agent`. |
| **B (service) ↔ C (spawn/update)** | `ballast serve [--port 0] [--dev] [--supervised]`; `service.json` (apiVersion, version, pid, url, token, defaultProjectId) + `service.lock`; shutdown always exits 0; `GetServiceInfo`/`GetHealth`/`ShutdownService`; service stage layout below. C never changes service state files. |
| **A (shell) ↔ C (spawn/update)** | Electron IPC: `service.status` (phase/running/version), `service.start`, `service.stop`, `service.restart`, `update.install`. UI Settings/tray call these; the renderer never spawns processes. |
| **Stage layout** | `<userData>/service/<version>/{main.mjs,plan-worker.mjs,web/}`; the running stage is never overwritten; `service.json` lives in `<state>/ballast/`. |

### A — `apps/desktop` (Electron) + `apps/web` (Solid UI) against `MockAgentLayer`

Can start now; independent of the in-flight engine work.

| Task | Notes | Gate |
|---|---|---|
| A1 Electron skeleton | Single instance, `--background`, window loads `BALLAST_UI_URL` (dev) or the discovered service URL; tray menu; update stub; fallback “Starting Ballast…” page; no product data. | — |
| A2 UI scaffold | Solid + Vite; project switcher; Scripts, Projects, Connections, Cloud, Settings routes; `AgentClient` context; `WatchService` store; mock transport from `MockAgentLayer` in the browser/test harness. | A1 |
| A3 Full v1 screens | Projects add/remove; script manifest/params/consent/logs/events; connection fields/auth; cloud pairing; service Settings. Use the two-project mock. | A2 |
| A4 Real transport switch | If `VITE_SERVICE_URL`/`?service=` is present use WS + token; otherwise mock. New-script “not started” state and enabled semantics tested against the mock. | A2 |
| A5 Shell checks | Quit UI vs stop service menu items; service status IPC; update banner; tray notification for pending consent. | A1/C4 |
| A6 Tests/stories | Component stories per screen against the mock; a Playwright smoke (or Electron test) that loads the UI with the mock and adds/removes a project. | A2–A4 |

Acceptance: the whole UI works in a browser against `MockAgentLayer`; the packaged shell opens
that UI, and quitting the window leaves the service process alive.

### B — `ballast serve` real service in `apps/agent`

Mostly **[wait]** for the Twitch-wiring agent. Start with B1/B6 which touch only new files where
possible; do not rewrite `run.ts`/`runtime-session.ts` until its owner lands.

| Task | Notes | Wait on |
|---|---|---|
| B1 service bootstrap | New `serve` entry: token + `service.json` + lock, HTTP/WS, `/health`, `/rpc` with protocol handlers (stub data first), static `web/`, `--supervised`, graceful shutdown. | — |
| B2 ProjectManager/ProjectStore | Register roots (`projects.json`); per-project `.ballast`; add/remove; watch `scripts/**/*.ts`; project-scoped script discovery. | planner manifest shape |
| B3 ScriptManager | Extract one-script lifecycle from `run.ts`/`runtime-session.ts`; plan → diff → consent; start/stop/restart; generations; `enabled` resume; new scripts stopped. Keep the in-process CLI. | **apps/agent/run.ts etc.** |
| B4 ConnectionManager + shared bus | One driver per service-wide connection; reference-count by running manifests; scopes union; reconnect; per-project topic filters. | **apps/agent drivers, integrations** |
| B5 Logs/events | Worker log notification or structured stdout; tag project/script; ring buffers + `seq`; bus tap for inbound/outbound events; `StreamLogs`/`StreamEvents`. | **runtime protocol in packages/core** |
| B6 CloudLink | Pairing begin/claim, relay reconnect, Twitch cloud transport; one per service. | **apps/cloud / 0002** (can start against existing HTTP) |
| B7 lifecycle RPCs | `ShutdownService` (exit 0), project/script/consent handlers, health counts. | B1 |
| B8 contract tests | Start the real service in a temp project; call every `AgentRpcs` member; assert worker/connection/log/event behaviour. | B1–B6 |

Acceptance: `pnpm --filter @ballast/agent serve` starts, discovers, serves the UI, runs two
projects' scripts, keeps running after the client disconnects, and stops on RPC.

### C — service spawn, replace and update in the shell

Can start now against a stub stage (`main.mjs` that writes `service.json` and answers `/health`).

| Task | Notes | Gate |
|---|---|---|
| C1 Launcher | Stage service + UI; spawn detached `ELECTRON_RUN_AS_NODE=1 process.execPath <stage>/main.mjs serve` (stdin ignored, logs appended to `service.log`/`service.err.log`, `windowsHide`, `unref`). | — |
| C2 Start/stop/restart | `service.start` adopts/replaces/spawns; `service.stop` = `ShutdownService` → wait → `SIGTERM` → `SIGKILL`; `service.restart` = stop + spawn; status IPC for UI. CLI `ballast service …` does the same from its own runtime. | C1 |
| C3 Adoption/replace | Read `service.json`, probe `/health` (same pid), adopt the shipped version; replace another version (stop → spawn → verify), respawn the previous stage on failure; stop before app update; clean old stages. | B1 |
| C4 Tray/UI/CLI wiring | “Quit UI” leaves service; “Stop Ballast” stops; Settings shows running/version; restart only where the caller can respawn (desktop, CLI). | A5, B7 |
| C5 E2E lifecycle | Start, quit UI (service alive), explicit stop (no orphan), version replace/rollback, app update with service running (quiesce + respawn). | B8 |

Acceptance: opening the app starts (or adopts) the service; quitting the app leaves scripts
running; an app update replaces the service without losing state; stop and restart work from
tray, Settings and CLI.

### Sequencing

```
A1 ─► A2 ─► A3 ─► A4 ─► A6 ─┐
                             ├─► integration (A4 + B8 + C5)
B1 ─► B7 ─► B8 ──────────────┤
B2/B3/B4/B5/B6 (wait) ───────┘
C1 ─► C2 ─► C3 ─► C4 ─► C5 ─┘
```

A1–A2, B1/B7, and C1 can start now in parallel. B2–B6 wait for their named owners. C3 needs B1
only for the real probe; it can use a stub until then. A3/A4 need only the protocol mock, so the
UI can be finished before the service is.

---

## 6. Open questions

1. **Service runtime long-term.** Electron’s Node is decided for v1. If Ballast later needs to run
   headless without the desktop app (a server install, CI, or a Linux host), do we ship stock
   Node or keep Electron’s runtime as a dependency?
2. **Node vs Bun for the service.** Bun compile is attractive for a single binary but unproven
   with `worker_threads` + rolldown’s N-API binding. Schedule the runtime spike before committing.
3. **UI hosting.** Service-served UI is chosen for one origin and version lockstep. Is there a
   reason to bundle the UI in the shell (offline first paint, smaller service) that outweighs the
   version skew and auth complexity?
4. **Twitch local-app auth.** The service’s loopback callback needs a registered redirect URI
   (`http://127.0.0.1:<port>/oauth/twitch/callback`) with a fixed port or Twitch’s localhost
   rules. Confirm the flow against the Twitch app registration UX before B6.
5. **Graphs.** `ScriptView.kind === "graph"` is reserved. Is a graph computed from the manifest
   (triggers → handlers → requests), or does the planner need to emit graph metadata? Decide
   before building the graph renderer.
6. **Protocol auth for MCP/agents.** The single bearer token is fine for the shell/CLI. MCP
   clients should get scoped, revocable tokens; define that before exposing MCP beyond localhost.
7. **Rune trigger.** Which Rune release/features would actually justify the port? Write the
   checklist down when Rune 1.0 is near, rather than porting for its own sake.
8. **Windows QA.** The detached spawn (`windowsHide`, no console) is unit-tested on macOS only;
   confirm on Windows that no console flashes and the service survives the app quitting.

---

## Appendix: commands run

| Command | Result |
|---|---|
| `git -C ~/github.com/anomalyco/rune pull --ff-only` | `fatal: Not possible to fast-forward, aborting.` Local `dev` 181 ahead / 2,629 behind. |
| `git -C ~/github.com/anomalyco/rune-desktop pull` | `Your configuration specifies to merge with refs/heads/main ... no such ref was fetched.` |
| `pnpm --filter @ballast/agent-protocol typecheck` | `tsgo -b`, clean |
| `pnpm --filter @ballast/agent-protocol test` | 13 tests passed |
| `pnpm typecheck` (root) | clean |
| `pnpm test` (root) | all workspace tests passed, including 13 agent-protocol tests |
| `du -sh .../OpenCode Beta.app` | 655 MB (Frameworks 276 MB, app.asar 203 MB, opencode-cli 174 MB) |
| `ls -lh $(which node)` | 112 MB |
| Rune browser engine sizes | `installer.rs`: 128 MB macOS, 142 MB Windows; CEF `156.4.0` |

**What this change did not do:** no Electron or Rune app was built or run. The shell decision is
based on the repos, the shipped OpenCode app and the OS API surface above. A1/C1 should start with a one-day packaging spike (unsigned app, tray, `ELECTRON_RUN_AS_NODE` service spawn,
update feed) before the full shell work is planned as done.

Files added by this decision:

- `packages/agent-protocol/{package.json,tsconfig.json,src/*.ts,test/rpc.test.ts}`
- `docs/decisions/0003-desktop-app-and-agent-service.md` (this file)
- root `tsconfig.json` reference to `packages/agent-protocol` (append only)
