# @ballast/desktop

The Ballast desktop shell: one Electron window, a tray item, and the launcher/updater for the
background agent service. It implements decision 0003 tasks **A1**, **A5** and **C1–C4**:

- A1: single instance, `--background`, window loads the discovered service URL (token → HttpOnly
  cookie exchange) or `BALLAST_UI_URL` in development, "Starting Ballast…" fallback, tray menu.
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

- **Electron 44.9.1 / electron-builder 26.15.7 / electron-updater 6.8.9** match the shipping
  OpenCode Desktop (0003 §1) so packaging and updater behaviour are the same beta line.
- **esbuild, not electron-vite**, bundles main/preload. The product UI is served by the agent
  service; the only bundled renderer is a static "Starting Ballast…" page, so a Vite renderer
  pipeline adds nothing here.
- **electron-updater is pinned literally (6.8.9)**, not via `catalog:`: electron-builder validates
  that dependency's version string and cannot parse pnpm's catalog placeholder.
- **Plain TypeScript in the launcher**, with Effect only behind `src/main/service/controls.ts`.
  The shell is plain process management (`child_process`, `fs`, `fetch`), so staging and
  start/stop stay small and unit-tested. `ShutdownService` and `ReportShellPermission` use the
  typed agent RPC over authenticated WebSocket; `SIGTERM`/`SIGKILL` are the fallback when the
  service is wedged.

## Run it

```bash
pnpm --filter @ballast/desktop dev                  # build + Electron (window)
pnpm --filter @ballast/desktop dev -- --background  # start in the tray only
```

With the web dev server (decision 0003 §3):

```bash
BALLAST_UI_URL=http://localhost:5173 pnpm --filter @ballast/desktop dev
```

Without `BALLAST_UI_URL` the window waits for `service.json`, loads the service UI at
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
| `BALLAST_UI_URL` | load a Vite dev UI instead of the service origin |
| `BALLAST_AUTOSTART` | `0`: do not start the service on launch (fallback-page E2E) |
| `BALLAST_START_TIMEOUT_MS` | start/verify budget (default 30000) |
| `BALLAST_UPDATE_URL` | build-time generic electron-updater feed |

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
Old stages are removed on launch and after a successful replacement, keeping the running stage.

### Building the real service

```bash
# dev: builds apps/web + apps/agent/dist-service, then Electron
pnpm --filter @ballast/desktop dev

# reuse an existing build
BALLAST_SERVICE_SKIP_BUILD=1 pnpm --filter @ballast/desktop dev

# packaging: builds and copies dist-service to Resources/service (outside app.asar)
pnpm --filter @ballast/desktop run pack
```

`script/service-build.mjs` runs `pnpm --filter @ballast/web build` and then
`node apps/agent/scripts/build-service.mjs`, so `dist-service/web/` contains the real Solid UI.
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
  electron-updater installs. The relaunched app's `start()` spawns the new version. This is the
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
  version: 1;
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
The service **token is never part of the bridge**; only main reads it and navigates the window.

Renderer security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no remote
content in the app session, permission requests denied, new windows/navigation to foreign origins
handed to the OS browser. The fallback page is local and uses the same preload.

## Packaging

```bash
pnpm --filter @ballast/desktop run pack   # unsigned .app in dist/mac-arm64 (--dir)
pnpm --filter @ballast/desktop run dist   # dmg + zip on macOS, NSIS on Windows
```

Use `run pack`: bare `pnpm --filter … pack` is pnpm's own tarball command.

Measured locally (macOS 26.5.1, arm64, unsigned):

| Item | Size |
|---|---|
| `Ballast.app` unpacked | **~295 MB** |
| `Contents/Frameworks` | 293 MB |
| `Contents/Resources/app.asar` | ~1 MB (main + preload; no product UI) |
| `Contents/Resources/service` | real service stage + runtime `node_modules` |

The service sits **outside app.asar** via `extraResources: build-service → Resources/service`, so
it can be spawned as a separate process. The app carries no product UI bundle. `BALLAST_APP_ID`
overrides the bundle id for test builds; release builds still need signing/notarization and an
icon (`mac.identity` is explicitly `null` for local builds).

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
3. **App updater feed/signing.** `electron-updater` is wired, but an unsigned local build has no
   `app-update.yml`; `update.status` reports `unavailable`. Release builds need a feed
   (`BALLAST_UPDATE_URL`), signing/notarization and an app icon.
4. **Windows not executed here.** The detached spawn uses `windowsHide`; confirm on Windows that
   no console flashes and the service survives the app quitting.
5. **Permissions.** macOS Accessibility is queried by the shell; Input Monitoring has no public
   Electron query. Windows/Linux report `granted`. The service restarts keyboard drivers when the
   shell reports a change, but the user may still have to grant Accessibility in System Settings.
6. **Single service per user** is enforced by the service's `service.lock`; the shell does not
   prevent two different userData roots from starting a service.
7. **No crash restart or start at login.** Nothing restarts a crashed service until the app or CLI
   is opened again (by design; there is no OS supervisor).
8. **Service update E2E**: version replacement is covered by the launcher tests against the stub;
   a full signed app-update (electron-updater replacing the bundle) still needs a real feed.
9. **Real-world integrations** (OBS, Twitch, VTube Studio, MIDI, keyboard hooks) still need
   validation against the actual applications/devices; the service tests use mocks and fakes.
