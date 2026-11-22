# `@ballast/web`

The reduced Ballast desktop UI: three screens (Scripts, Connections, Settings), a project
selector, and a read-only Source viewer. It is a pure client of `@ballast/agent-protocol`; it
does not import the agent or Alchemy.

## Stack

| Choice | Version | Why |
|---|---|---|
| SolidJS | `1.9.17` | Decision 0003 pins the line used by OpenCode Desktop. |
| `@solidjs/router` | `1.0.0` | `HashRouter`, so the service can serve `dist/` statically without an SPA fallback. |
| Vite | `8.3.8` | Dev server + small build. `base: "./"` keeps assets relative. |
| Tailwind CSS | `4.3.5` | Layout utilities only; colour, typography and elevation come from the vendored OpenCode tokens below. |
| highlight.js | `11.12.0` | TypeScript tokenising for the Source tab. Core + the TypeScript grammar only; the full package and theme CSS are not imported. |
| Vitest + Playwright | workspace / `1.65.1` | Store/client tests in Node against the mock; browser smoke and screenshots. |

## Theme

The custom Ballast palette, dark class, themed cards, icon set and component kit were removed.
The stylesheet now vendors the minimal OpenCode design tokens from:

- `~/github.com/anomalyco/opencode/packages/ui/src/styles/tokens/colors.css`
- `~/github.com/anomalyco/opencode/packages/ui/src/styles/tokens/theme.css`
- `~/github.com/anomalyco/opencode/packages/ui/src/theme/themes/oc-2.json`
- `~/github.com/anomalyco/opencode/packages/ui/src/actions/button/button.css`
- `~/github.com/anomalyco/opencode/packages/ui/src/forms/text-input/text-input.css`

Source commit: **`766379ee81a9ee5496e1f96ab573c250a5907d9f`** (`anomalyco/opencode`, 2.3.2 line).
The token names (`--v2-background-bg-*`, `--v2-text-text-*`, `--v2-border-border-*`,
`--v2-state-*`, `--v2-elevation-*`, `--syntax-*`) are kept so they map back to OpenCode.

The published `@opencode/ui` 2.3.2 package was evaluated but not used: it is ~8 MB unpacked,
pulls its component dependency tree and `@opencode/util` workspace references, and its token CSS
is keyed to `prefers-color-scheme` rather than the in-app System/Light/Dark choice. Vendoring the
subset is smaller and keeps the theme switch explicit.

Tokens are written out per scheme and selected with `data-color-scheme="light|dark"` on `<html>`.
`src/ui/theme.ts` implements System / Light / Dark, follows `prefers-color-scheme` in System mode,
and persists the choice in `localStorage` under `ballast.theme`. `index.html` applies it before
the app loads.

Typography follows OpenCode: Inter/system sans at 440/530/670 weights, IBM Plex Mono/SF Mono for
paths and code, 28px controls, 6px radii, alpha borders and the OC-2 warm-neutral greys.

### Cursor rule

Desktop-app convention, matching OpenCode: nothing shows a hand cursor except links that leave
the app. `src/styles.css` sets `cursor: default` on the body and on buttons, tabs, options,
switches, labels, selects, summaries and anchors; only `a[target="_blank"]`, absolute
`http(s)` links and `[data-external-link]` get `cursor: pointer`. No `cursor-pointer` utility is
used. Playwright asserts the rule on a button, nav link, script row, tab and an external auth link.

## Screens

- **Scripts** — project selector at the top of the sidebar; a plain list of name, path, status dot
  and Start/Stop. No stats, filters, generation/updated columns or per-row resume switches.
- **Script detail** — header with status and Start/Stop; inline consent banner with Approve/Reject;
  a short parameter form (enum selects, text/number save on blur or Enter, boolean switch); a
  compact collapsible manifest (connections, topics, requests, scopes, unresolved); and only two
  tabs: **Logs** and **Source**.
- **Connections** — one list of integration/label/slot, status and one action per row. The action
  opens a small settings dialog with fields, Twitch auth mode (Auto/Cloud/Local app), scopes,
  Connect/Disconnect and browser/device authorization. No per-connection dashboard.
- **Settings** — service info, restart/stop; projects add/remove; cloud pair/unpair; theme.

Removed on purpose: Projects dashboard, Cloud screen, stat cards, event inspector, graph
placeholder, overview cards, shortcut overlay, shell-bridge UI, success/info toasts and the old
custom icon set. Protocol support for events and graphs remains in `@ballast/agent-protocol`; the
reduced UI simply does not render it. Toasts are errors only.

## Data layer

`src/agent/client.ts` builds one Effect `ManagedRuntime`:

- **Mock** (default): `RpcTest.makeClient(AgentRpcs)` provided with `MockAgentLayer`.
- **WebSocket**: `RpcClient.make(AgentRpcs)` over `RpcClient.layerProtocolSocket` +
  `Socket.layerWebSocket("/rpc")`.

Selection, highest priority first: `?service=<url>&token=<token>`, then
`VITE_SERVICE_URL`/`VITE_SERVICE_TOKEN`, else the in-browser mock.

`src/state/store.ts` holds one `WatchService` subscription (snapshot + events), one global
`StreamLogs` subscription, per-script detail caching, source revisions, project selection and
all mutations. It keeps the last snapshot while reconnecting and resumes logs with `afterSeq`.

The browser cannot send an `Authorization` header on a WebSocket upgrade, so the token is appended
to the RPC URL. Production should use the service's `HttpOnly` session cookie set by
`/?token=…`; the service must accept either credential on `/rpc`.

## `GetScriptSource` additions

The reduced UI adds the read-only Source tab, backed by an additive protocol change:

```ts
export const GetScriptSource = Rpc.make("GetScriptSource", {
  payload: ScriptIdRequest, // { projectId, scriptId }
  success: ScriptSource,
  error: AgentError,
})

export const ScriptSource = Schema.Struct({
  path: Schema.String,          // project-relative, e.g. scripts/tick-echo.ts
  content: Schema.String,
  sha256: Schema.String,        // lowercase hex
  updatedAt: Schema.Number,
  language: Schema.Literal("typescript"),
})
```

`ServiceEvent` also has the additive `script-source-changed` variant
(`{ projectId, scriptId, sha256, updatedAt }`); the open Source tab refetches when it arrives.
`MockAgentLayer` returns realistic sources for the four mock scripts and hashes them with Web
Crypto. **The real service (`apps/agent`) must implement the new handler**; it is intentionally not
edited here.

## Development and build

```sh
pnpm --filter @ballast/web dev          # http://localhost:5173, mock by default
pnpm --filter @ballast/web typecheck
pnpm --filter @ballast/web test         # Vitest: store, transport, formatting
pnpm --filter @ballast/web test:e2e     # Playwright smoke + screenshots
pnpm --filter @ballast/web build        # -> apps/web/dist
```

Point the dev server at a live agent with:

```sh
VITE_SERVICE_URL=http://127.0.0.1:53124 VITE_SERVICE_TOKEN=<token> \
  pnpm --filter @ballast/web dev
# or http://localhost:5173/?service=http://127.0.0.1:53124&token=<token>
```

### Serving contract for the agent service

`apps/web/dist/` contains `index.html` and `assets/index-<hash>.{css,js}`.

- Serve the contents of `dist/` at the service origin's `/`.
- `base: "./"` means all asset URLs are relative; the same build works on any loopback port.
- The app uses hash routes (`/#/scripts`, `/#/connections`, `/#/settings`), so **no SPA
  fallback is required**.
- Set `Referrer-Policy: no-referrer` on `/`. The token must never be readable from JavaScript.
- Keep `/rpc`, `/health` and `/oauth/*` out of the static handler. `index.html` no-cache,
  hashed assets immutable.
- The build makes no external network requests; fonts fall back to system fonts, and
  highlight.js is bundled.

## Tests and evidence

- `src/state/store.test.ts` — snapshot, project add/remove/validation, params, consent, external
  watch changes, live logs, connections/auth, cloud, lifecycle and `fetchScriptSource`.
- `src/agent/client.test.ts` — mock default, query/env precedence, ws/wss, token handling.
- `src/lib/format.test.ts` — reduced status presentation.
- `e2e/smoke.spec.ts` — switch project, start/stop, approve consent, logs, source, connection
  dialog, no page errors, no #boot placeholder, viewport filled, cursor rule; plus dark and light
  screenshots of Scripts, script detail, Source, consent, Connections, the connection dialog and
  Settings.

Screenshots: `screenshots/dark-01-scripts.png` … `light-07-settings.png`.

Bundle before the redesign: **408.98 kB JS / 48.57 kB CSS** (118.54 / 8.68 kB gzip).
Bundle after: **333.03 kB JS / 30.13 kB CSS** (106.61 / 6.65 kB gzip), including highlight.js.

## Known protocol gaps

1. `ParamView.optionsSource` names a live option source but there is no RPC to resolve it. Static
   `options` render as a select; otherwise the field falls back to text.
2. There is no `CreateConnection`/`AddConnection` RPC, so the Connections list only shows
   connections the service already knows about.
3. Browser WebSockets cannot send a bearer header; the service needs `?token=` or the session
   cookie on `/rpc`.
4. `ServiceSnapshot` has no manifests, so script detail still fetches `GetScript`.
5. The Source tab needs the new `GetScriptSource` handler in `apps/agent` (listed above).
