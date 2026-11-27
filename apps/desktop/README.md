# @ballast/desktop

The Ballast desktop shell: a registry of home and project windows, a tray item, and the
launcher/updater for the background agent service. It implements decision 0003 tasks **A1**,
**A5** and **C1–C4**:

- A1: single instance, `--background`, each window loads the discovered service URL (token →
  HttpOnly cookie exchange) or `BALLAST_UI_URL` in development, "Starting Ballast…" fallback,
  tray menu.
- A5: quit-UI vs stop-service are separate; service status comes from IPC; pending-consent count
  from `/health`; update state is an IPC event.
- C1: versioned service staging and a detached `ballast serve` spawn (no OS supervisor).
- C2: typed IPC bridge for `service.*` and `update.install`.
- C3: discovery/adoption, version replacement, verification and rollback, old-stage cleanup.
- C4: tray, application menu and IPC call the same launcher functions.

The real service is `apps/agent/dist-service` (`ballast serve` plus the built Solid UI in
`web/`). `dev` and `pack` build and stage it by default; `dev/stub-service` is only used by the
shell's unit tests.

## Tooling choices

- **Electron 44.9.1 / electron-builder 26.15.7** match the shipping OpenCode Desktop (0003 §1),
  so packaging behaves the same as on that beta line.
- **Its own updater, not electron-updater.** Ballast updates from its own release service
  (`apps/release`, the anomalyco/release protocol), whose manifests electron-updater can't read
  (SHA-256, display-only versions, rollout). `src/main/update/` follows the service's client rules and passes its test
  vectors. It verifies each download's size and SHA-256, then hands it to Squirrel.Mac (Electron's
  `autoUpdater`) or to the signed NSIS setup. See [docs/releasing.md](../../docs/releasing.md).
- **esbuild, not electron-vite**, bundles main/preload. The product UI is served by the agent
  service; the only bundled renderer is a static "Starting Ballast…" page, so a Vite renderer
  pipeline adds nothing here.
- **Plain TypeScript in the launcher**, with Effect only behind `src/main/service/controls.ts`.
  The shell is plain process management (`child_process`, `fs`, `fetch`), so staging and
  start/stop stay small and unit-tested. `ShutdownService` and `ReportShellPermission` use the
  typed agent RPC over authenticated WebSocket; `SIGTERM`/`SIGKILL` are the fallback when the
  service is wedged.

## Run it

```bash
pnpm dev                                            # Vite HMR + real service + Electron
pnpm --filter @ballast/desktop dev                  # same, from any directory
pnpm --filter @ballast/desktop dev -- --background  # start in the tray only
```

By default `dev` starts Vite on `http://127.0.0.1:5173` and points Electron at it with the real
service URL and token, so UI edits hot-reload without losing live projects or connections. The
agent service and Electron main/preload are still rebuilt once per launch. Use
`BALLAST_VITE_DEV=0 pnpm --filter @ballast/desktop dev` for the production-style built UI.

To use an already-running UI server instead:

```bash
BALLAST_UI_URL=http://localhost:5173 pnpm --filter @ballast/desktop dev
```

With the production-style flow the window waits for `service.json`, loads the service UI at
`http://127.0.0.1:<port>/?token=…` (the service sets an `HttpOnly; SameSite=Strict` cookie and
redirects to `/`), or shows the bundled fallback page while it comes up. Every launch calls
`service.start()` (the same call the tray uses), so the freshly built stage is started, or
replaces a running service of another version. Set `BALLAST_AUTOSTART=0` to skip that.

`script/dev.mjs` also reads the gitignored `apps/desktop/.env` and passes it to Electron and the
service it spawns. Existing environment variables win. Put the cloud you want in that file and
restart the dev app (the service must be respawned to pick it up):

```
# local cloud
BALLAST_CLOUD_URL=http://localhost:1338
# or Alchemy remote dev
BALLAST_CLOUD_URL=https://ballast-cloud-dev-brendonovich.brendonovich.workers.dev
```

Environment overrides, mostly for tests and development:

| Variable | Meaning |
|---|---|
| `BALLAST_APP_ID` | app id (default `dev.ballast.agent`) |
| `BALLAST_USER_DATA_DIR` | overrides Electron `userData` |
| `BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR` | service state/data/log paths |
| `BALLAST_SERVICE_BUILD_DIR` | service build to stage (default `../agent/dist-service` in dev, `Resources/service` when packaged) |
| `BALLAST_SERVICE_SKIP_BUILD`, `BALLAST_SERVICE_SKIP_WEB_BUILD` | reuse an existing agent/web build when running device/pack |
| `BALLAST_SERVICE_VERSION` | force the staged version (otherwise `version.json` / `package.json`) |
| `BALLAST_SERVICE_PORT` | fixed port for development (default random) |
| `BALLAST_UI_URL` | load an already-running dev UI instead of starting Vite automatically |
| `BALLAST_VITE_DEV` | `0`: skip Vite and load the production-style service UI |
| `BALLAST_AUTOSTART` | `0`: do not start the service on launch (fallback-page E2E) |
| `BALLAST_START_TIMEOUT_MS` | start/verify budget (default 30000) |
| `BALLAST_RELEASE_URL` | overrides the stamped release service URL for update checks |
| `BALLAST_VERSION`, `BALLAST_CHANNEL`, `BALLAST_RELEASE_ORIGIN` | `script/pack.mjs`: app version, release channel and release service URL. Stamping a channel (`out/release.json`) turns the updater on. |

## Service stage

Expected build layout (0003 §2):

```
<build>/
  main.mjs            # serve entry; run as: ELECTRON_RUN_AS_NODE=1 electron <stage>/main.mjs serve
  plan-worker.mjs     # new Worker(new URL("./plan-worker.mjs", import.meta.url))
  web/                # built Solid UI served at /
  version.json        # optional: { "version": "0.1.0" }
```

On start it is copied to:

```
<userData>/service/<version>/…
<stateDir>/service.json             # written by the service (0600)
<stateDir>/service.lock             # single-instance lock (created with wx)
<logDir>/service.log, service.err.log  # the detached process's stdout/stderr (appended)
```

A stage is **never overwritten**: the same version reuses the directory even if the bundled files
changed, so the version must change for new code. Dev builds append a content hash to the
version, so a rebuilt service is a new stage and `dev` replaces the running service with it.
Vite dev stages append `+vite` and start the service with `--dev`, keeping its origin
rules separate from a production-style service when switching between the two flows.
Old stages are removed on launch and after a successful replacement, keeping the running stage.

### Building the real service

```bash
# dev: builds apps/agent/dist-service, then Vite + Electron
# (also builds apps/web when BALLAST_VITE_DEV=0)
pnpm dev

# reuse an existing build
BALLAST_SERVICE_SKIP_BUILD=1 pnpm --filter @ballast/desktop dev

# packaging: builds and copies dist-service to Resources/service (outside app.asar)
pnpm --filter @ballast/desktop run pack
```

`script/service-build.mjs` runs `pnpm --filter @ballast/web build` when the built UI is
needed and then `node apps/agent/scripts/build-service.mjs`, so `dist-service/web/` contains the
real Solid UI. The default Vite dev flow skips the redundant production web build.
The service honours `BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR`,
`BALLAST_SERVICE_PORT`; writes `service.json` with `apiVersion`, `version`, `url`, `token`, `pid`,
`startedAt`; answers `GET /health` with `ok`, `apiVersion`, `version`, `pid`; and always exits
**0** on shutdown.

## Lifecycle and discovery

- Discovery order: `BALLAST_STATE_DIR/service.json`, then `BALLAST_DATA_DIR/service.json`; the URL
  must be loopback HTTP(S). The shell validates `schemaVersion`, `name === "ballast-agent"`,
  token/pid, and adopts only `apiVersion === 1` when `/health` answers with the same pid.
- Liveness/version/adoption comes from `GET /health`. `GetServiceInfo` is **not** called over RPC
  in main: decision 0003 defines `/health` for the shell/CLI and requires it to carry
  pid/version/apiVersion. `service.json` supplies the token; `/health` supplies liveness.
- There is **no OS supervisor** (no LaunchAgent, Scheduled Task or login item), as in OpenCode's
  background service. The launcher spawns
  `ELECTRON_RUN_AS_NODE=1 <electron> <userData>/service/<version>/main.mjs serve` with
  `detached: true`, stdin ignored, stdout/stderr appended to `<logDir>/service.log` /
  `service.err.log`, `windowsHide`, then `unref()`. The service outlives the UI and has no idle
  exit; it does not start at login (it starts when the app or CLI is opened).
- Single instance is the service's job: `service.lock` is created exclusively. A live lock pid
  means running or still starting, so a second spawn exits; only a dead pid or a live pid that
  never registered within 5 minutes is stale.
- Start (every launch, tray, bridge): adopt a running service of the shipped version; replace one
  of any other version (stop → spawn the new stage → verify `/health` version → clean old stages;
  on failure respawn the previous stage); otherwise spawn and wait for `/health`.
- Stop: `ShutdownService` over RPC, wait for exit, then `SIGTERM`, then `SIGKILL`. Restart is
  stop + spawn.
- App update: `update.install` calls `prepareForAppUpdate()` (stop the service), then
  Squirrel.Mac swaps the bundle or the NSIS setup installs over the app. The relaunched app's `start()` spawns the new version. This is the
  "quiesce before replacing the app binary" step in 0003 §2.

## Renderer bridge (C2)

Types live at **`apps/desktop/src/bridge.ts`** and are exported as **`@ballast/desktop/bridge`**
(package export). The file has no imports and no Electron runtime dependency, so the web app can
use it type-only:

```ts
import type { BallastBridge, ServiceStatus, ServiceAction } from "@ballast/desktop/bridge";
```

If `apps/web` does not depend on `@ballast/desktop` yet, a relative type-only import works:
`../../apps/desktop/src/bridge.ts`.

Preload exposes `window.ballast`: 

```ts
interface BallastBridge {
  version: 2;
  service: {
    status(): Promise<ServiceStatus>;
    start(): Promise<ServiceAction>;    // adopt, replace another version, or spawn; verify
    stop(): Promise<ServiceAction>;     // ShutdownService, then SIGTERM/SIGKILL
    restart(): Promise<ServiceAction>;  // stop + spawn
  };
  permissions: {
    status(): Promise<ServicePermissions>;             // accessibility: granted | denied | unknown
    requestAccessibility(): Promise<ServicePermissions>; // macOS prompt / System Settings, no-op elsewhere
  };
  update: {
    status(): Promise<UpdateState>;
    install(): Promise<UpdateAction>;
  };
  windows: {
    context(): Promise<WindowContext>; // home route or project id for this window
    openProjectWindow(projectId: string, options?: { newWindow?: boolean }): Promise<void>;
    openHome(route?: "projects" | "connections" | "settings"): Promise<void>;
  };
  projects: {
    setMenu(projects: ReadonlyArray<{ id: string; name: string }>): Promise<void>;
  };
  app: {
    info(): Promise<AppInfo>;
    openUi(): Promise<void>;             // navigate to the service origin with a fresh token
    retry(): Promise<void>;              // re-run discovery
    showLogs(): Promise<void>;
    openExternal(url: string): Promise<void>; // http(s) only
    pickDirectory(): Promise<string | null>;   // native folder picker; null when cancelled
  };
  events: {
    onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
    onUpdateStatus(listener: (state: UpdateState) => void): () => void;
  };
}
```

`ServiceStatus` carries phase (`stopped | starting | restarting | stopping | running | updating |
error`), the running flag, running and built versions, apiVersion, pid, loopback URL,
pending-consent count, `updateAvailable` (a service of another version is running),
`lastError`, `permissions.accessibility`, and the state/data/stage/log paths.
The service **token is never part of the bridge**; only main reads it. Every window separately
loads the token URL, which the service turns into an HttpOnly cookie for that window.

## Windows

- A home window has no project and shows the project list, Connections and Settings.
- A project window has one project id. The registry reuses/focuses an existing project window
  instead of opening a duplicate; opening from home reuses that home window.
- `File → New Window` (Cmd/Ctrl+N), `File → Open Project ▸` and the tray project list drive the
  registry. Titles are `<Project> — Ballast` from the renderer or `Ballast` for home.
- Open project windows and bounds live in `<userData>/windows.json`; relaunch restores them, or
  opens one home window when none were saved. Normal window close updates the session; quit writes
  it synchronously before Electron exits.
- The renderer subscribes logs only for its project; a project window has no stream for other
  projects. Closing the UI never stops the detached service or its workers.

Renderer security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no remote
content in the app session, permission requests denied, new windows/navigation to foreign origins
handed to the OS browser. The fallback page is local and uses the same preload.

## Packaging

```bash
pnpm --filter @ballast/desktop run pack   # unsigned: dist/release/Ballast.app.zip (macOS) or dist/release/app (Windows)
node apps/desktop/script/pack.mjs --installer <unpacked app> --out <dir>   # Windows: NSIS setup around a (signed) app
```

Pack output is always unsigned. `.github/workflows/release.yml` signs, notarizes and publishes it;
[docs/releasing.md](../../docs/releasing.md) has the details. Ballast ships macOS arm64 and Windows x64. The NSIS
setup is a one-click, per-user install that writes `install.json` (the receipt that lets the app
update itself). `script/test-installer.ps1` checks it in CI.

Use `run pack`: bare `pnpm --filter … pack` is pnpm's own tarball command.

Measured locally (macOS 26.5.1, arm64, unsigned):

| Item | Size |
|---|---|
| `Ballast.app` unpacked | **~295 MB** |
| `Contents/Frameworks` | 293 MB |
| `Contents/Resources/app.asar` | ~1 MB (main + preload; no product UI) |
| `Contents/Resources/service` | real service stage + runtime `node_modules` |

The service sits **outside app.asar**, so it can be spawned as a separate process. It's staged
in `build-service/service` and copied to `Resources/service` via `extraResources`. It's nested one level
because electron-builder always drops a `node_modules` directly under an extraResources source.
The app carries no product UI bundle. `BALLAST_APP_ID` overrides the bundle id for test builds.
There's no app icon yet.

## Verification

```bash
pnpm --filter @ballast/desktop typecheck
pnpm --filter @ballast/desktop test          # vitest: shell + stub only
pnpm --filter @ballast/desktop test:e2e      # real service, real UI, service outlives the UI
```

Vitest covers config resolution, discovery/adoption, staging/cleanup, the stub service exit
contract, and launcher cycles against a real detached stub process: spawn → adopt → restart → stop,
and replacing a running service of another version with the shipped build. The stub exists only
for these tests; dev and pack stage `apps/agent/dist-service`.

The Playwright E2E builds the real agent service and uses throwaway state/data/userData dirs. It
runs the `--ballast-demo=start` entry point, then uses the CLI to add a temp fake-tick project,
configure, start it and approve consent, and asserts worker ticks. It then launches Electron with
`_electron`, loads the real service UI, checks the bridge (same pid, Accessibility state reaches
`/health.permissions.accessibility`), screenshots it, quits the UI, and asserts the service pid
and ticks continue. Finally `--ballast-demo=stop` must leave no process and no `service.json`.
A second test runs with `BALLAST_AUTOSTART=0` and checks the bundled fallback page. The screenshot
is written under `test-results/<test>/ballast-e2e-ui.png`.

The same lifecycle can be driven by hand with the hidden demo entry point (use throwaway dirs):

```bash
ROOT=/tmp/ballast-demo
BIN=./node_modules/.bin/electron
COMMON=(env BALLAST_APP_ID=dev.ballast.agent.test
  BALLAST_USER_DATA_DIR=$ROOT/userData BALLAST_STATE_DIR=$ROOT/state
  BALLAST_DATA_DIR=$ROOT/data BALLAST_LOG_DIR=$ROOT/logs)

"${COMMON[@]}" $BIN . --ballast-demo=start      # stage + detached spawn + verify /health
"${COMMON[@]}" $BIN . --ballast-demo=status
"${COMMON[@]}" $BIN . --background --ballast-quit-after-ms=2000  # quit UI; pid must stay
"${COMMON[@]}" $BIN . --ballast-demo=restart    # stop + spawn -> new pid
"${COMMON[@]}" $BIN . --ballast-demo=stop       # process and service.json gone
```

Nothing is registered with the OS, so `--ballast-demo=stop` (or killing the pid in
`$ROOT/state/service.json`) is the only cleanup; service output is in `$ROOT/logs/service.log`.

## Known gaps / integration notes

1. **Control RPC auth uses `/rpc?token=` for the shell.** Electron's main process uses Node's
   global WebSocket, which cannot set handshake headers. The service accepts the bearer token in
   the query **only** for `/rpc`; the UI and CLI keep cookies/headers. Do not log RPC URLs.
2. **App/web integration.** `window.ballast` is typed in `src/bridge.ts` and available on every
   window, including the service origin. The web app can import the type and use
   `permissions.requestAccessibility()`, but should not expect a token; main exchanges it for a
   cookie.
3. **App updates.** Only release builds (stamped with a channel by CI) check for updates. Dev and
   local builds report `unavailable`. The macOS path was exercised locally: two builds signed with
   the release entitlements updated through Squirrel from a local manifest server. The Windows NSIS
   update path (`--updated /S --force-run`) and a notarized release have not been run yet.
4. **Windows not executed here.** The detached spawn uses `windowsHide`; confirm on Windows that
   no console flashes and the service survives the app quitting.
5. **Permissions.** macOS Accessibility is queried by the shell; Input Monitoring has no public
   Electron query. Windows/Linux report `granted`. The service restarts keyboard drivers when the
   shell reports a change, but the user may still have to grant Accessibility in System Settings.
6. **Single service per user** is enforced by the service's `service.lock`; the shell does not
   prevent two different userData roots from starting a service.
7. **No crash restart or start at login.** Nothing restarts a crashed service until the app or CLI
   is opened again (by design; there is no OS supervisor).
8. **Service update E2E**: version replacement is covered by the launcher tests against the stub.
9. **Real-world integrations** (OBS, Twitch, VTube Studio, MIDI, keyboard hooks) still need
   validation against the actual applications/devices; the service tests use mocks and fakes.
