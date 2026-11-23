# `@ballast/web`

The Ballast desktop UI: SolidJS + Vite + TypeScript, served by the agent service at `/`.
It is a pure client of `@ballast/agent-protocol` and `@ballast/desktop/bridge`
(type-only for the Electron bridge); it does not import the agent or Alchemy.

## Stack

| Choice | Version | Why |
|---|---|---|
| SolidJS | `1.9.17` | Decision 0003 pins the line used by OpenCode Desktop. |
| `@solidjs/router` | `1.0.0` | `HashRouter`, so `dist/` works on a plain static server without SPA fallback. |
| Vite | `8.3.8` | Dev server + small build, `base: "./"`. |
| Tailwind CSS | `4.3.5` | Layout utilities only; colour, type and elevation come from OpenCode tokens. |
| highlight.js | `11.12.0` | Core + TypeScript/JSON grammars for the Source pane. |
| Vitest / Playwright | workspace / `1.65.1` | Store/client tests, mock UI smoke, real-service smoke, screenshots. |

## Theme

The stylesheet vendors a reduced subset of OpenCode's design tokens from
`anomalyco/opencode` **`766379ee81a9ee5496e1f96ab573c250a5907d9f`** (the 2.3.2 line):

- `packages/ui/src/styles/tokens/colors.css`
- `packages/ui/src/styles/tokens/theme.css`
- `packages/ui/src/theme/themes/oc-2.json`
- `packages/ui/src/actions/button/button.css`
- `packages/ui/src/forms/text-input/text-input.css`

Values are written per scheme under `data-color-scheme="light|dark"`, using the OpenCode token
names (`--v2-background-bg-*`, `--v2-text-text-*`, `--v2-border-border-*`, `--v2-state-*`,
`--v2-elevation-*`, `--syntax-*`). Typography follows OpenCode: Inter/system at 440/530/670,
IBM Plex Mono/SF Mono, 28px controls, 6px radii and alpha borders.

**Cursor rule:** nothing shows a hand cursor except links that leave the app. Body, buttons,
tabs, options, switches, labels, selects, summaries and anchors use `cursor: default`; only
`target="_blank"`, absolute `http(s)` links and `[data-external-link]` use `pointer`. The
splitter uses `row-resize`, which is a resize cursor, not a pointer.

## Windows and routes

The app follows a VS Code-like window model.

- **Home** (`/`, `/projects`, `/connections`, `/settings`) has no project. It shows the
  project list with status, **New project** and **Add folder**, plus the service-wide Connections
  and Settings pages. The 204px sidebar has only those service-wide destinations.
- **Project** (`/projects/:id`) shows one project workspace and nothing about the other
  projects. A 44px icon rail reaches home, Connections and Settings; those service-wide pages open
  in a home window. Project logs are subscribed with the project id, so a project window only
  streams what it shows. Closing a window never stops the project or the service.
- Opening a project from home uses the current window. Cmd/Ctrl+click or **Open in new window**
  opens a separate window; an already-open project focuses its existing window instead of making a
  duplicate.
- Electron has Cmd/Ctrl+N (**File → New Window**), **File → Open Project ▸**, and a tray project
  list with **Show Ballast**. Window titles are `<Project> — Ballast` or `Ballast`.
- Open project windows and their bounds are stored in `<userData>/windows.json` and restored on
  relaunch; with no saved project windows the app opens one home window.
- A plain browser is route-scoped: `/` is home, `/projects/:id` is the project, and
  “open in new window” becomes a new tab.

## Screens

- **Projects** (`/`, `/projects`) — the home window lists every project with status, units and
  **New project** / **Add folder**. New project asks for a name and
  an optional folder; with the desktop bridge the folder comes from the native picker, while a
  plain browser shows a path field. The optional folder defaults to
  `~/ballast-projects/<slug>`. A newly created project is stopped and has a Start action.
- **Project** (`/projects/:id`) — a full-height workspace with no page scroll. Units are grouped
  by kind (topics, timers, workflows, params, runs) with status, last activity and a
  `file:line` source link. The header shows running / stopped / needs consent /
  “Running previous version” and Start, Stop and Restart based on whether a worker is live, so a
  failed reload offers Stop/Restart instead of Start. The consent banner carries the summary,
  Reject and Approve. A failed reload keeps the old worker and shows the message once, with the
  declaration as a source link.
  The center is a **Source** pane over a **Logs** pane with a draggable splitter
  (`ballast.projectSplit`), double-click reset, per-pane maximize and Escape restore. Source
  browses `ListProjectFiles` in a file tree, reads files, jumps to and highlights a line, and
  refetches on `project-file-changed` (and project changes). Logs accept a unit filter or a click
  on a unit row. The right **Project** sidebar (300px, persisted collapse, auto-collapsed below
  1200px) holds project parameters, connection bindings and pending timers with Cancel.
  Parameters show their title and description (not the raw key), support string, number, boolean,
  enum and `strings` (multi-select) values, and use `ParamView.options` when the service resolves
  an `optionsSource`. Each connection requirement has a compatible-instance picker, an inline
  **Add connection…** action that pre-filters the add flow and binds on creation, and a hint for
  proposed vs unbound slots. Rebinding a live project asks before restarting it; unbound slots
  disable Start.
- **Connections** — service-wide; open from any window's compact rail in a home window. Instances are grouped by integration. Each row shows its label,
  status, account login/avatar, project slots that use it, and Manage/Delete. A bound instance
  cannot be deleted and explains that it must be unbound first. **Add connection** is driven by
  `ListIntegrations`: integration, description, allowed modes, auth requirement and field set,
  then label, connect and auth where needed. Twitch own-app mode shows the client id/secret and
  the fixed `redirectUrl` with a copy action. Twitch cloud mode lists the Twitch accounts from
  `ListCloudAccounts` with login, display name, avatar when available, scopes and
  reauthorization state; a sole account is preselected, and **Link another account** opens the
  cloud's `/oauth/twitch/start`. The dialog also edits, connects/disconnects, re-authorizes and
  keeps the approval/permission states keyed by instance. Keyboard dialogs hide the redundant
  editable macOS permission field; the accessibility status line plus **Open System Settings**
  is the only control.
- **Projects** also show **Needs connections** when an explicit binding or sole-instance proposal
  is missing; Review opens the project's connection picker.
- **Settings** — service/desktop state, stop (restart in the desktop app), cloud pair/unpair and
  appearance.

Event inspection, graph view, stat cards and success/info toasts remain removed. Logs and Source
are always visible together; there are no tabs.

## Desktop bridge

When `window.ballast` exists, Settings uses the desktop launcher through the type-only contract
`@ballast/desktop/bridge` (version 2):

- initial `service.status()` plus `events.onServiceStatus`;
- service phase, running state and running/built version;
- Restart/Stop call `service.restart()` / `service.stop()`, not the RPCs (restart is stop + spawn,
  which only the desktop can do);
- `app.pickDirectory()` opens the native folder picker for **New project** and **Add folder**.
- `windows.context()`, `windows.openProjectWindow(projectId, { newWindow })` and
  `windows.openHome(route)` drive the multi-window registry; `projects.setMenu(projects)` feeds
  the File and tray menus. Every window authenticates by loading the service with a fresh token,
  which becomes the HttpOnly cookie for that window.

Outside Electron the same rows fall back to `GetServiceInfo`/`GetHealth`, and only Stop is shown
(`ShutdownService`): a browser cannot respawn the service. There is no install/uninstall; the
service is a background process the desktop app or CLI starts. The bridge is type-checked but not
bundled at runtime.

### Permissions and connection approvals

- The bridge's `permissions.status()` is queried when Connections opens. A non-granted startup
  state is reported with `ReportShellPermission` only when no keyboard connection exists to
  reconcile; the shell owns reporting after an actual request.
- **Accessibility** approval rows/buttons only render when `window.ballast` exists. A keyboard
  connection with a non-granted permission shows **Needs permission** instead of **Connected**.
  The dialog shows `Accessibility permission: denied|unknown|granted` and one action:
  `Open System Settings` (or `Check again` when granted). The request goes through
  `bridge.permissions.requestAccessibility()`; the main process reports the result through
  `ReportShellPermission`.
- **VTube Studio** approval is service data (`ConnectionSummary.approval`). The row shows the
  service message and opens a dialog with one `Check again` action; the user must click Allow inside
  VTube Studio.
- Plain browsers hide accessibility approvals and their dead-end warnings cleanly. VTube Studio
  approval remains because it is not shell-owned.

## Data layer

`src/agent/client.ts` builds one Effect `ManagedRuntime`:

- **Mock** (default in Vite dev): `RpcTest.makeClient(AgentRpcs)` + `MockAgentLayer`.
- **WebSocket**: `RpcClient.make(AgentRpcs)` over `RpcClient.layerProtocolSocket` +
  `Socket.layerWebSocket("/rpc")`.

Transport selection: `?service=<url>&token=<token>`, then `VITE_SERVICE_URL`/`VITE_SERVICE_TOKEN`,
then the mock. When the service itself serves a **production build**, there is no query parameter;
the UI probes same-origin `/health` and uses a same-origin WebSocket with the session cookie. Vite
dev never probes, so mock mode stays quiet.

`src/state/store.ts` keeps one `WatchService` subscription and one `StreamLogs` subscription
(started after the snapshot). Project details are cached per id and refreshed on
`project`/`project-changed`/`reload-failed`/`project-consent` revisions; file panes wake on
`project-file-changed`; pending project consents are seeded with `ListProjectConsents` and kept
current by events. Connection CRUD writes its returned `ConnectionSummary` back; bindings update
the local `boundBy` lists immediately and write the returned `ProjectDetail` back. The store
keeps the last snapshot while reconnecting and resumes logs with `afterSeq`.

The web app uses **no legacy script RPC**. `ListScripts`, `GetScript`, `GetScriptSource`,
`PlanScript`, `StartScript`, `StopScript`, `RestartScript`, `SetScriptParam`,
`SetScriptEnabled`, `ListConsents`, `ApproveConsent` and `RejectConsent` are absent from
`apps/web`.

## Development and build

```sh
pnpm --filter @ballast/web dev          # mock UI at http://localhost:5173
pnpm --filter @ballast/web typecheck
pnpm --filter @ballast/web test         # Vitest: store, transport, formatting
pnpm --filter @ballast/web test:e2e     # builds dist, then Playwright (mock + real service)
pnpm --filter @ballast/web build        # -> apps/web/dist
```

Point dev at a live agent with `VITE_SERVICE_URL`/`VITE_SERVICE_TOKEN`, or open
`?service=http://127.0.0.1:PORT&token=...`. The service must allow the Vite origin only with
`--dev`.

`test:e2e` uses `e2e/global-setup.ts` to spawn the real service with temp state/data dirs,
`BALLAST_PROJECTS_DIR`, and `BALLAST_WEB_DIR=apps/web/dist`. It starts a VTube Studio fixture
(`e2e/vts-fixture-server.ts`) that leaves AuthenticationToken pending, creates VTube Studio and
Keyboard connection instances through the service RPC, and records their ids plus the approval
states. The real-service spec creates projects through the UI; no fixture project is pre-added.
Teardown calls `/shutdown`, stops the VTS fixture, and removes the temp dirs. The mock specs run
against Vite.

### Serving contract for the agent service

`apps/web/dist/` contains `index.html`, `assets/index-<hash>.{css,js}` and `favicon.svg`.

- Serve the contents of `dist/` at `/`.
- `base: "./"` keeps asset URLs relative to any loopback port.
- Hash routes (`/#/projects`, `/#/settings`) need **no SPA fallback**.
- Set `Referrer-Policy: no-referrer`; never inline the token into HTML.
- Keep `/rpc`, `/health` and `/oauth/*` out of the static handler.
- `index.html` no-cache, hashed assets immutable. No external requests are made.

## Tests and screenshots

- `src/state/store.test.ts` — snapshot/projects, create/add/remove, detail and units,
  start/stop, watch changes, project files, connections/auth, cloud, lifecycle.
- `src/agent/client.test.ts` — mock default, query/env precedence, ws/wss, token handling.
- `src/lib/format.test.ts` — project, unit and connection presentation.
- `e2e/smoke.spec.ts` — mock: home → project route scope, compact project rail, project
  workspace,
  units, source, logs+source split, sidebar parameter area, splitter drag + persistence,
  maximize/restore both panes, sidebar collapse/expand, narrow auto-collapse, connection dialog,
  cursor rule, no page errors, `#boot` gone and viewport filled. Two-window screenshots are
  composed from two mock project pages when ffmpeg is available.
- `e2e/bridge.spec.ts` — fake `window.ballast`: running state, restart/stop through the bridge,
  native folder picker.
- `e2e/approvals.spec.ts` — real service VTube Studio and macOS Accessibility approval rows,
  status text, request hook, and light/dark dialog screenshots.
- `e2e/real-service.spec.ts` — real service served UI: create an OBS instance with no project
  against a mock obs-websocket server, create a project needing `obs/main`, see the proposed
  binding, Start-confirm it, review consent bindings, start the worker, add a second OBS instance,
  rebind the running project with the restart warning, verify the service refuses deleting the
  bound instance, and observe **Needs connections** for a project with two candidate instances.
  Also covers unit-filtered logs, source jump, failed reload, string/strings parameters and timer
  cancel.

Screenshots (1440×1000):

```
screenshots/dark-01-projects.png
screenshots/dark-02-new-project.png
screenshots/dark-03-project.png
screenshots/dark-home.png
screenshots/dark-project-window.png
screenshots/dark-project-second.png
screenshots/dark-two-windows.png
screenshots/dark-04-source.png
screenshots/dark-05-logs.png
screenshots/dark-06-connections.png
screenshots/dark-07-settings.png
screenshots/light-01-projects.png … light-07-settings.png
screenshots/light-home.png
screenshots/light-project-window.png
screenshots/light-project-second.png
screenshots/light-two-windows.png

screenshots/real-dark-01-projects.png
screenshots/real-dark-02-new-project.png
screenshots/real-dark-03-project.png
screenshots/real-dark-04-source-jump.png
screenshots/real-dark-05-logs-unit.png
screenshots/real-dark-06-consent.png
screenshots/real-dark-07-reload-failed.png
screenshots/real-dark-08-connections.png
screenshots/real-dark-09-add-connection.png
screenshots/real-dark-10-project-connections.png
screenshots/real-light-01-projects.png … real-light-10-project-connections.png

screenshots/approvals-vtuber-studio-dark.png
screenshots/approvals-vtuber-studio-light.png
screenshots/approvals-accessibility-dark.png
screenshots/approvals-accessibility-light.png
```

Bundle before the redesign: **408.98 kB JS / 48.57 kB CSS** (118.54 / 8.68 kB gzip).
Bundle now: **371.75 kB JS / 31.06 kB CSS** (118.17 / 6.76 kB gzip).

## Known protocol gaps / notes

1. Dynamic `optionsSource` values are only present in `ParamView.options` when the project slot
   is bound. A `strings` param shows its current selection until the service returns options.
2. Browser WebSockets cannot send a bearer header; the service accepts `?token=` or the session
   cookie.
3. The source pane refetches on `project-file-changed`; because project planning also publishes
   project changes, it treats those as a cue to refresh the current file as well.
4. Removing a project is not exposed in the UI after project management moved out of Settings.
