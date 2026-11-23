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
  The shell is event-driven OS process management (`launchctl`, `schtasks`, `fs`, `fetch`), so
  staging/handoff stay plain and unit-tested. `ShutdownService`, `RestartService` and
  `ReportShellPermission` use the typed agent RPC over authenticated WebSocket; launchctl /
  Task Scheduler remain the fallback when the service is wedged.

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
redirects to `/`), or shows the bundled fallback page while it comes up. `dev` sets
`BALLAST_DEV=1`, so a launch with no running service installs and starts the freshly built stage
automatically (the same `service.install`/`service.start` calls the tray uses). Set
`BALLAST_DEV=0` to skip that.

Environment overrides, mostly for tests and development:

| Variable | Meaning |
|---|---|
| `BALLAST_APP_ID`, `BALLAST_SERVICE_LABEL` | app id / LaunchAgent label / task name (default `dev.ballast.agent`) |
| `BALLAST_USER_DATA_DIR` | overrides Electron `userData` |
| `BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR` | service state/data/log paths |
| `BALLAST_LAUNCH_AGENTS_DIR` | plist directory (default `~/Library/LaunchAgents`) |
| `BALLAST_SERVICE_BUILD_DIR` | service build to stage (default `../agent/dist-service` in dev, `Resources/service` when packaged) |
| `BALLAST_SERVICE_SKIP_BUILD`, `BALLAST_SERVICE_SKIP_WEB_BUILD` | reuse an existing agent/web build when running device/pack |
| `BALLAST_SERVICE_VERSION` | force the staged version (otherwise `version.json` / `package.json`) |
| `BALLAST_SERVICE_PORT` | fixed port for development (default random) |
| `BALLAST_UI_URL` | load a Vite dev UI instead of the service origin |
| `BALLAST_DEV` | `1` (dev default): install/start the built service on launch; `0` disables |
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
`startedAt`; answers `GET /health` with `ok`, `apiVersion`, `version`, `pid`; exits **0** on
shutdown and **75** for restart.

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
- Stop: `ShutdownService` over RPC, then `launchctl bootout` (the plist stays; `installed` is
  true, `running` false). Start: `launchctl bootstrap` / `kickstart`. Restart: `RestartService`
  exits 75 and launchd starts a fresh generation. If the RPC fails (older or wedged service), the
  launcher falls back to `launchctl kickstart -k`.
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
`updateAvailable`, `lastError`, `permissions.accessibility`, and the state/data/stage/log paths.
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
it can be spawned by launchd/Task Scheduler. The app carries no product UI bundle. `BALLAST_APP_ID`
overrides the bundle id for test builds; release builds still need signing/notarization and an
icon (`mac.identity` is explicitly `null` for local builds).

## Verification

```bash
pnpm --filter @ballast/desktop typecheck
pnpm --filter @ballast/desktop test          # vitest: shell + stub only
pnpm --filter @ballast/desktop test:e2e      # real service, real LaunchAgent, real UI
```

Vitest covers config resolution, discovery/adoption, staging/cleanup, LaunchAgent plist and
Windows task/wrapper generation, the handoff state machine, the stub service exit contract, and a
launcher install → restart → stop → start → uninstall cycle against a real stub process. The
stub exists only for these tests; dev and pack stage `apps/agent/dist-service`.

The Playwright E2E builds the real agent service, launches Electron with `_electron`, installs a
throwaway LaunchAgent label (`dev.ballast.agent.e2e.<pid>.<time>`), adds a temp fake-tick project,
starts it, approves consent, asserts worker logs, loads the real service UI, opens the script detail,
screenshots it, quits the UI, asserts the service pid and ticks continue, then uninstalls and
asserts the plist, `service.json` and process are gone. It also asserts that the desktop's
Accessibility state reaches `/health.permissions.accessibility`. The screenshot is written under
`test-results/<test>/ballast-e2e-ui.png`.

The same lifecycle can be driven by hand with the hidden demo entry point (use a throwaway label):

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

The Playwright E2E passes on macOS 26.5.1 (arm64): install, fake-tick script, UI screenshot,
UI quit with the service still ticking, uninstall with no plist/process. The vitest suite has 31
tests. The earlier packaged-app and v1→v2→broken-v3 rollback observations used the stub and still
apply to the handoff state machine.

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
4. **Windows not executed here.** Task XML and VBS are unit-tested. Task Scheduler restarts on any
   non-zero exit (not only 75); the Run-key path is generated but not installed by the runtime.
5. **Permissions.** macOS Accessibility is queried by the shell; Input Monitoring has no public
   Electron query. Windows/Linux report `granted`. The service restarts keyboard drivers when the
   shell reports a change, but the user may still have to grant Accessibility in System Settings.
6. **Single service per user** is enforced by the service's `service.lock`; the shell does not
   prevent two different userData roots from starting a service.
7. **Service update E2E** is covered by the state-machine tests and a launchd v1→v2→broken-v3
   rollback run; a full signed app-update (electron-updater replacing the bundle) still needs a
   real feed.
8. **Real-world integrations** (OBS, Twitch, VTube Studio, MIDI, keyboard hooks) still need
   validation against the actual applications/devices; the service tests use mocks and fakes.
