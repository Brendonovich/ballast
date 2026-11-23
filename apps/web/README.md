# `@ballast/web`

The Ballast desktop UI: SolidJS + Vite + TypeScript, served by the agent service at
`/`. It is a pure client of `@ballast/agent-protocol` and `@ballast/desktop/bridge`
(type-only for the Electron bridge); it does not import the agent or Alchemy.

## Stack

| Choice | Version | Why |
|---|---|---|
| SolidJS | `1.9.17` | Decision 0003 pins the line used by OpenCode Desktop. |
| `@solidjs/router` | `1.0.0` | `HashRouter`, so `dist/` works on a plain static server without SPA fallback. |
| Vite | `8.3.8` | Dev server + small build, `base: "./"`. |
| Tailwind CSS | `4.3.5` | Layout utilities only; colour, type and elevation come from OpenCode tokens. |
| highlight.js | `11.12.0` | Core + TypeScript grammar only, for the Source pane. |
| Vitest / Playwright | workspace / `1.65.1` | Store/client tests, mock UI smoke, real-service smoke, screenshots. |

## Theme

Custom Ballast colours, icons, cards and dark-class theming were removed. The stylesheet
vendors a reduced subset of OpenCode's design tokens from
`anomalyco/opencode` **`766379ee81a9ee5496e1f96ab573c250a5907d9f`** (the 2.3.2 line):

- `packages/ui/src/styles/tokens/colors.css`
- `packages/ui/src/styles/tokens/theme.css`
- `packages/ui/src/theme/themes/oc-2.json`
- `packages/ui/src/actions/button/button.css`
- `packages/ui/src/forms/text-input/text-input.css`

The published `@opencode/ui@2.3.2` package was evaluated but not used: it is ~8 MB unpacked,
pulls a large component dependency tree and `@opencode/util` workspace references, and its token
CSS follows `prefers-color-scheme` instead of the in-app System/Light/Dark setting. The vendored
subset keeps the OpenCode token names (`--v2-background-bg-*`, `--v2-text-text-*`,
`--v2-border-border-*`, `--v2-state-*`, `--v2-elevation-*`, `--syntax-*`) and writes the values
per scheme under `data-color-scheme="light|dark"`. Typography follows OpenCode (Inter/system,
440/530/670 weights, IBM Plex Mono/SF Mono), as do 28px controls, 6px radii and alpha borders.

**Cursor rule:** nothing shows a hand cursor except links that leave the app. Body, buttons,
tabs, options, switches, labels, selects, summaries and anchors use `cursor: default`; only
`target="_blank"`, absolute `http(s)` links and `[data-external-link]` use `pointer`. The
splitter uses `row-resize`, which is a resize cursor, not a pointer.

## Screens

- **Scripts** — project selector in the sidebar; a plain list of name, path, status dot and
  Start/Stop.
- **Script detail** — a full-height workspace with no page scroll:
  compact header (back, name, status, Start/Stop), inline consent banner, and a **Source** pane on
  top plus **Logs** below. The horizontal splitter is draggable, persisted in localStorage
  (`ballast.scriptSplit`), resettable by double click, and clamped so both panes stay usable. Each
  pane has a maximize/restore control; maximizing keeps the other pane's header bar, and Escape
  restores. Source keeps highlighting, line numbers, copy-path and refresh-on-change; Logs keeps
  autoscroll with a “Latest” button after scrolling up, clear, and live status.
  A fixed-width right **Parameters** sidebar (300px, persisted collapse, auto-collapsed below
  1100px) holds the short form and a collapsible Manifest (connections, topics, scopes).
- **Connections** — one list of integration · slot, status and one action per row. The action opens
  a small dialog with fields, Twitch mode, scopes and browser/device auth. No dashboard.
- **Settings** — service/desktop state, restart/stop, projects add/remove, cloud pair/unpair and
  appearance.

There are no tabs any more; Logs and Source are always visible together. Event inspection, graph
view, stat cards and success/info toasts remain removed. Hooks for upcoming VTS/keyboard
needs-action states are marked in `src/screens/ConnectionsScreen.tsx` and `src/bridge.ts`.

## Desktop bridge

When `window.ballast` exists, Settings uses the Electron supervisor through the type-only contract
`@ballast/desktop/bridge`:

- initial `service.status()` plus `events.onServiceStatus`;
- service phase, installed/running state, running/installed version and supervisor;
- Restart/Stop call `service.restart()` / `service.stop()` (supervisor-aware), not the RPCs;
- Install is shown only when `status.installed === false`; Uninstall lives in an explicit
  **Advanced** disclosure once installed.

Outside Electron the same rows/buttons fall back to `GetServiceInfo`/`GetHealth` and
`RestartService`/`ShutdownService` RPCs. The bridge is type-checked but not bundled at runtime.

Upcoming hooks:
- `src/bridge.ts` — `HOOK(permissions)` for macOS Accessibility via
  `permissions.requestAccessibility()`.
- `src/screens/ConnectionsScreen.tsx` — `HOOK(connection-needs-action)` for the distinct VTube
  Studio waiting-for-approval state, to become one banner/row with one action.

## Data layer

`src/agent/client.ts` builds one Effect `ManagedRuntime`:

- **Mock** (default in Vite dev): `RpcTest.makeClient(AgentRpcs)` + `MockAgentLayer`.
- **WebSocket**: `RpcClient.make(AgentRpcs)` over `RpcClient.layerProtocolSocket` +
  `Socket.layerWebSocket("/rpc")`.

Transport selection: `?service=<url>&token=<token>`, then `VITE_SERVICE_URL`/`VITE_SERVICE_TOKEN`,
then the mock. When the service itself serves a **production build**, there is no query parameter;
the UI probes same-origin `/health` and uses a same-origin WebSocket with the session cookie. Vite
dev never probes, so mock mode stays quiet.

`src/state/store.ts` keeps one `WatchService` subscription, one `StreamLogs` subscription (started
after the snapshot), per-script details and source revisions, and writes mutation results straight
into the store. It keeps the last snapshot while reconnecting and resumes logs with `afterSeq`.

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

`test:e2e` uses `e2e/global-setup.ts` to spawn the real service with temp state/data dirs and
`BALLAST_WEB_DIR=apps/web/dist`, add a temp project under `examples/` containing the repo's
`tick-echo.ts` and `obs-scene.ts`, and write the URL/token/project id to
`test-results/real-service.json`. If spawning fails, the real-service spec is skipped. Teardown
calls `/shutdown`, removes the project and temp dirs. The mock spec runs against Vite.

### Serving contract for the agent service

`apps/web/dist/` contains `index.html`, `assets/index-<hash>.{css,js}` and `favicon.svg`.

- Serve the contents of `dist/` at `/`.
- `base: "./"` keeps asset URLs relative to any loopback port.
- Hash routes (`/#/scripts`, `/#/settings`) need **no SPA fallback**.
- Set `Referrer-Policy: no-referrer`; never inline the token into HTML.
- Keep `/rpc`, `/health` and `/oauth/*` out of the static handler.
- `index.html` no-cache, hashed assets immutable. No external requests are made.

## `GetScriptSource` additions

`packages/agent-protocol` gained:

```ts
ScriptSource = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  sha256: Schema.String,
  updatedAt: Schema.Number,
  language: Schema.Literal("typescript"),
})

GetScriptSource = Rpc.make("GetScriptSource", {
  payload: ScriptIdRequest,
  success: ScriptSource,
  error: AgentError,
})
```

It is in `AgentRpcs`. `ServiceEvent` also has the additive `script-source-changed` variant
(`{ projectId, scriptId, sha256, updatedAt }`); the open Source pane refetches when it arrives.
`MockAgentLayer` returns realistic sources and hashes them with Web Crypto. The real service
implements the handler in `apps/agent/src/service/rpc.ts` and publishes source changes from its
project scan.

## Tests and screenshots

- `src/state/store.test.ts` — snapshot, project add/remove, params, consent, watch changes, live
  logs, connections/auth, cloud, lifecycle, `fetchScriptSource`.
- `src/agent/client.test.ts` — mock default, query/env precedence, ws/wss, token handling.
- `src/lib/format.test.ts` — reduced status presentation.
- `e2e/smoke.spec.ts` — mock: project switch, start/stop, consent, logs+source simultaneously,
  sidebar parameter edit, splitter drag + persistence, maximize/restore both panes, sidebar
  collapse/expand, narrow auto-collapse, connection dialog, cursor rule, no page errors, #boot
  gone and viewport filled.
- `e2e/bridge.spec.ts` — fake `window.ballast`: installed/running state, Advanced uninstall,
  restore/stop through the bridge; not-installed install flow.
- `e2e/real-service.spec.ts` — real service served UI: project selector, consent→approve,
  start/logs/source, parameter edit, OBS connection dialog, Settings, and real screenshots.

Screenshots (1440×1000):

```
screenshots/dark-01-scripts.png … dark-08-settings.png
screenshots/light-01-scripts.png … light-08-settings.png
screenshots/real-01-scripts.png
screenshots/real-02-script.png
screenshots/real-03-consent.png
screenshots/real-04-script-running.png
screenshots/real-05-connections.png
screenshots/real-06-connection-dialog.png
screenshots/real-07-settings.png
screenshots/real-08-script-light.png
```

Bundle before the redesign: **408.98 kB JS / 48.57 kB CSS** (118.54 / 8.68 kB gzip).
Bundle now: **341.71 kB JS / 28.94 kB CSS** (108.84 / 6.50 kB gzip).

## Known protocol gaps / notes

1. `ParamView.optionsSource` has no RPC to resolve live option values; static `options` render as a
   select, otherwise the field is text.
2. No `CreateConnection`/`AddConnection` RPC; the list shows service-known connections only.
3. Browser WebSockets cannot send a bearer header; the service accepts `?token=` or the session
   cookie.
4. Real service script titles include the file extension ("Tick Echo Ts"); the UI strips a
   trailing extension/Ts for display without changing the record.
5. Real connections can have `label === slot`; the row shows integration · slot and omits a
   redundant subtitle.
