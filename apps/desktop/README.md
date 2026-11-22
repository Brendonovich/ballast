# @ballast/desktop

The Ballast desktop shell: one Electron window, a tray item, and the installer/updater for the
background agent service. It implements decision 0003 tasks **A1**, **A5** and **C1–C4**:

- A1: single instance, `--background`, window loads the discovered service URL (token → HttpOnly
  cookie exchange) or `BALLAST_UI_URL` in development, "Starting Ballast…" fallback, tray menu.
- A5: quit-UI vs stop-service are separate; service status comes from IPC; pending-consent count
  from `/health`; update state is an IPC event.
- C1: versioned service staging and a macOS LaunchAgent / Windows Scheduled Task.
- C2: typed IPC bridge for `service.*` and `update.install`.
- C3: discovery/adoption, version handoff, verification and rollback, old-stage cleanup.
- C4: tray, application menu and IPC call the same launcher functions.

The real service (`ballast serve`) is being built in `apps/agent`. Until it lands, this package
ships a small stub service with the real `serve` contract.

## Tooling choices

- **Electron 44.9.1 / electron-builder 26.15.7 / electron-updater 6.8.9** match the shipping
  OpenCode Desktop (0003 §1) so packaging and updater behaviour are the same beta line.
- **esbuild, not electron-vite**, bundles main/preload. The product UI is served by the agent
  service; the only bundled renderer is a static "Starting Ballast…" page, so a Vite renderer
  pipeline adds nothing here.
- **electron-updater is pinned literally (6.8.9)**, not via `catalog:`: electron-builder validates
  that dependency's version string and cannot parse pnpm's catalog placeholder.
- **Plain TypeScript in the main process**, not Effect. The shell is event-driven OS process
  management (`launchctl`, `schtasks`, `fs`, `fetch`); Effect would only add an RPC client for two
  calls. The launcher/stage/handoff modules are dependency-free and unit-tested. When the real
  service lands, the RPC adapter can be added behind `controls.ts` without changing the bridge.

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
redirects to `/`), or shows the bundled fallback page while it comes up.

Environment overrides, mostly for tests and development:

| Variable | Meaning |
|---|---|
| `BALLAST_APP_ID`, `BALLAST_SERVICE_LABEL` | app id / LaunchAgent label / task name (default `dev.ballast.agent`) |
| `BALLAST_USER_DATA_DIR` | overrides Electron `userData` |
| `BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR` | service state/data/log paths |
| `BALLAST_LAUNCH_AGENTS_DIR` | plist directory (default `~/Library/LaunchAgents`) |
| `BALLAST_SERVICE_BUILD_DIR` | service build to stage (default `dev/stub-service` in dev, `Resources/service` when packaged) |
| `BALLAST_SERVICE_VERSION` | force the staged version (otherwise `version.json` / `package.json`) |
| `BALLAST_SERVICE_PORT` | fixed port for development (default random) |
| `BALLAST_UI_URL` | load a Vite dev UI instead of the service origin |
| `BALLAST_RESTART_THROTTLE_SECONDS` | launchd `ThrottleInterval` (default 5) |
| `BALLAST_START_TIMEOUT_MS` | start/verify budget (default 30000) |
| `BALLAST_UPDATE_URL` | build-time generic electron-updater feed |

## Service stage

Expected build layout (0003 §2):

```
<build>/
  main.mjs            # serve entry; run as: electron <stage>/main.mjs serve --standalone
  plan-worker.mjs     # new Worker(new URL("./plan-worker.mjs", import.meta.url))
  web/                # built Solid UI served at /
  version.json        # optional: { "version": "0.1.0" }
```

At install time it is copied to:

```
<userData>/service/<version>/…
<userData>/service/installed.json   # pointer written after a successful handoff
<stateDir>/service.json             # written by the service (0600)
```

A stage is **never overwritten**. Re-running install with the same version reuses the directory
even if the bundled files changed; bump the version to hand off. Old stages are removed on launch
and after a successful handoff, keeping the running/installed stage.

### Switching from the stub to the real service

```bash
# development
BALLAST_SERVICE_BUILD_DIR=../agent/dist/serve \
BALLAST_SERVICE_VERSION=0.2.0 \
pnpm --filter @ballast/desktop dev

# packaging (copies that directory to Resources/service outside app.asar)
BALLAST_SERVICE_BUILD_DIR=../agent/dist/serve \
BALLAST_SERVICE_VERSION=0.2.0 \
pnpm --filter @ballast/desktop run pack
```

The real build must honour `BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR`,
`BALLAST_SERVICE_PORT`; write `service.json` with `apiVersion`, `version`, `url`, `token`, `pid`,
`startedAt`; answer `GET /health` with `ok`, `apiVersion`, `version`, `pid`; exit **0** on shutdown
and **75** for restart. No source changes in this package are needed.

## Lifecycle and discovery

- Discovery order: `BALLAST_STATE_DIR/service.json`, then `BALLAST_DATA_DIR/service.json`; the URL
  must be loopback HTTP(S). The shell validates `schemaVersion`, `name === "ballast-agent"`,
  token/pid, and adopts only `apiVersion === 1`.
- Liveness/version/adoption comes from `GET /health`. `GetServiceInfo` is **not** called over RPC
  in main: decision 0003 defines `/health` specifically for the supervisor and requires it to
  carry pid/version/apiVersion, and pulling Effect RPC + a WebSocket client into the main bundle
  for one call is unnecessary. `service.json` supplies the token; `/health` supplies liveness.
- macOS install: stage → write `~/Library/LaunchAgents/<label>.plist` → `launchctl bootout` the old
  job (ignore if absent) → `launchctl bootstrap gui/<uid> <plist>` → wait for `/health` with the
  expected version. The plist has `RunAtLoad`, `KeepAlive → SuccessfulExit = false`, environment
  `ELECTRON_RUN_AS_NODE=1`, state/data/log paths, and `ProgramArguments = [app binary, stage/main.mjs,
  serve, --standalone]`.
- Stop: ask the service to shut down, then `launchctl bootout` (the plist stays; `installed` is
  true, `running` false). Start: `launchctl bootstrap` / `kickstart`. Restart: ask the service to
  exit 75, and launchd starts a fresh generation. If the service has no control endpoint (real
  service uses RPC), restart falls back to `launchctl kickstart -k`.
- Windows: a generated hidden `ballast-service.vbs` sets the environment, runs
  `ELECTRON_RUN_AS_NODE=1 <app.exe> <stage>\main.mjs serve --standalone` with window style 0,
  **waits**, and quits with the child's code. A per-user logon Scheduled Task runs it with
  `IgnoreNew` and `RestartOnFailure` (PT1M/999), so exit 75 restarts. `buildRunKeyCommand` is the
  Run-key alternative. Generation is unit-tested; it has not been executed on Windows here.
- Update/handoff (C3): stage new version → stop → rewrite login item → start → verify expected
  version → clean old stage. If start/verify fails, rewrite/start/verify the previous stage. The
  pure reducer is in `src/main/service/handoff.ts` and is covered by `test/handoff.test.ts`.
- App update: `update.install` stops the service, writes `<userData>/update-relaunch.json`, and
  calls `electron-updater`. The relaunched app sees the marker and starts the installed service
  again. This is the "quiesce before replacing the app binary" step in 0003 §2.

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
    install(): Promise<ServiceAction>;    // stage, (re)write login item, start, verify
    uninstall(): Promise<ServiceAction>;  // stop + remove login item
    start(): Promise<ServiceAction>;
    stop(): Promise<ServiceAction>;
    restart(): Promise<ServiceAction>;
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
  };
  events: {
    onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
    onUpdateStatus(listener: (state: UpdateState) => void): () => void;
  };
}
```

`ServiceStatus` carries phase (`not-installed | installed | starting | restarting | stopping |
running | installing | updating | uninstalling | error`), installed/running flags, installed and
running versions, built version, apiVersion, pid, loopback URL, pending-consent count,
`updateAvailable`, `lastError`, and the state/data/stage/log paths. The service **token is never
part of the bridge**; only main reads it and navigates the window.

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
| `Contents/Resources/app.asar` | 1.2 MB |
| `Contents/Resources/service` | 20 KB (stub) |

The service sits **outside app.asar** via `extraResources: build-service → Resources/service`, so
it can be spawned by launchd/Task Scheduler. The app carries no product UI bundle. `BALLAST_APP_ID`
overrides the bundle id for test builds; release builds still need signing/notarization and an
icon (`mac.identity` is explicitly `null` for local builds).

## Verification

```bash
pnpm --filter @ballast/desktop typecheck
pnpm --filter @ballast/desktop test
```

31 tests cover config resolution, discovery/adoption, staging/cleanup, LaunchAgent plist and
Windows task/wrapper generation, the handoff state machine, the stub service exit contract, and a
launcher install → restart → stop → start → uninstall cycle against a real stub process.

The real launchd lifecycle can be driven with the hidden demo entry point (use a throwaway label):

```bash
ROOT=/tmp/ballast-launchd-demo
BIN=./node_modules/.bin/electron
COMMON=(env BALLAST_APP_ID=dev.ballast.agent.test BALLAST_SERVICE_LABEL=dev.ballast.agent.test
  BALLAST_USER_DATA_DIR=$ROOT/userData BALLAST_STATE_DIR=$ROOT/state
  BALLAST_DATA_DIR=$ROOT/data BALLAST_LOG_DIR=$ROOT/logs BALLAST_RESTART_THROTTLE_SECONDS=1)

"${COMMON[@]}" $BIN . --ballast-demo=install    # stage + plist + launchctl bootstrap + verify
"${COMMON[@]}" $BIN . --ballast-demo=status
"${COMMON[@]}" $BIN . --background --ballast-quit-after-ms=2000  # quit UI; pid must stay
"${COMMON[@]}" $BIN . --ballast-demo=restart    # exit 75 -> launchd -> new pid
"${COMMON[@]}" $BIN . --ballast-demo=stop       # process gone, plist retained
"${COMMON[@]}" $BIN . --ballast-demo=start
"${COMMON[@]}" $BIN . --ballast-demo=uninstall  # plist + process gone
```

Always clean up a test label afterwards:

```bash
launchctl bootout gui/$(id -u)/dev.ballast.agent.test 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/dev.ballast.agent.test.plist"
```

### Observed on this machine

- install: `ok: true`, pid 84416, launchctl state `running`, plist at
  `~/Library/LaunchAgents/dev.ballast.agent.test.plist`.
- quit UI (`--background --ballast-quit-after-ms=2000`): UI exit 0, service pid **84416 unchanged**,
  `/health` ok.
- restart: `launchctl print` showed `last exit code = 75: EX_TEMPFAIL`; pid 84416 → 84540.
- stop: `running: false`, `installed: true`, pid gone, `launchctl print` exit 113 (not loaded).
- uninstall: `not-installed`, plist missing, process gone, `launchctl print` exit 113.
- packaged app: `dist/mac-arm64/Ballast.app` installed from `Resources/service`, launchd ran the
  app binary with `ELECTRON_RUN_AS_NODE=1`, then uninstalled cleanly.
- service update: v1 → v2 `ok: true`, `runningVersion`/`installedVersion` = 0.0.0-stub.2, old v1
  stage removed. A deliberately broken v3 failed verification after 4 s and was rolled back:
  `ok: false`, message "service update failed and was rolled back to 0.0.0-stub.2", the running pid
  moved to v2, v3's stage was cleaned, and `installed.json` still points at v2.
- UI smoke (real window): title `Ballast service (stub)`, href
  `http://127.0.0.1:60426/` (no token in the final URL), `window.ballast` present with
  `service.status().phase === "running"`; after the UI exited, the service pid was unchanged.

## Known gaps / integration notes

1. **Real-service control RPC.** `src/main/service/controls.ts` currently POSTs `/shutdown` and
   `/restart` (implemented by the stub). The real service must expose `ShutdownService` /
   `RestartService` over `@ballast/agent-protocol`; add an adapter there and keep the supervisor
   fallback. Until then stop still works via `launchctl bootout`/SIGTERM, and restart falls back
   to `launchctl kickstart -k` (not the exit-75 path).
2. **`/health` must carry `apiVersion`, `version`, `pid`.** `@ballast/agent-protocol`'s
   `HealthStatus` currently omits them; 0003 §2 requires them for the supervisor. The shell falls
   back to `service.json.apiVersion` and uses `service.json.version` for verification, so a real
   service whose health endpoint omits version will still verify.
3. **Real build output.** `apps/agent` needs a `serve` build directory (see "Service stage") and a
   version file. Point `BALLAST_SERVICE_BUILD_DIR` at it; no code change here.
4. **app/web integration.** Import `BallastBridge` type-only, call `window.ballast` when present,
   subscribe to status events, and use `app.openUi()` for the fallback/retry path. The web app must
   not expect a token; it is exchanged for a cookie by main.
5. **App updater feed/signing.** `electron-updater` is wired, but an unsigned local build has no
   `app-update.yml`; `update.status` reports `unavailable`. Release builds need a feed
   (`BALLAST_UPDATE_URL`), signing/notarization and an app icon.
6. **Windows not executed here.** Task XML and VBS are unit-tested. Task Scheduler restarts on any
   non-zero exit (not only 75); the Run-key path is generated but not installed by the runtime.
7. **Single service per user** is enforced by the service's `service.lock`; the shell does not
   prevent two different userData roots from starting a service.
8. **Service update E2E** is covered by the state-machine tests and a launchd v1→v2→broken-v3
   rollback run; a full signed app-update (electron-updater replacing the bundle) still needs a
   real feed.
