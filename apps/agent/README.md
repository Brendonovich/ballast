# @ballast/agent

The `ballast` CLI and the long-running local service (`ballast serve`).

## Development

```bash
pnpm --filter @ballast/agent typecheck
pnpm --filter @ballast/agent test
pnpm --filter @ballast/agent serve        # long-running service
pnpm --filter @ballast/agent serve --port 0 --dev
```

`plan` and `run` remain in-process development commands; everything else (`status`, `projects`, `scripts`,
`connections`, `cloud`, `consent`, `service`) is a client of a running `serve` discovered through
`service.json`. When none is running, those commands start one in the background first (except
`ballast status`, and not when `BALLAST_SERVICE_URL` is set).

## Background service

```bash
ballast service start     # spawn a detached `ballast serve` (no-op if one is running)
ballast service status
ballast service restart   # stop + spawn
ballast service stop      # ShutdownService, then SIGTERM/SIGKILL
```

There is no OS supervisor (no LaunchAgent, Scheduled Task or start at login). `service start`
re-runs the CLI's own runtime and entry with `serve` as a detached process (stdin ignored,
output appended to `<logDir>/service.log` / `service.err.log`); it outlives the CLI and has no
idle exit. `service.lock` (created exclusively) keeps one service per user, and the service always
exits 0 on shutdown. `serve --supervised` instead exits when its parent closes stdin.

## MCP for coding agents

`ballast mcp` serves the Ballast MCP tools over stdio. It discovers the running
service through `service.json`, so start the service first. In OpenCode, add a
local server:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "ballast": {
        "type": "local",
        "command": [
          "node",
          "--experimental-strip-types",
          "--no-warnings=ExperimentalWarning",
          "/absolute/path/to/ballast/apps/agent/src/bin.ts",
          "mcp"
        ]
      }
    }
  }
}
```

The staged service bundle is also an MCP server: run `main.mjs mcp` from
`dist-service` (or the desktop's staged `service/<version>/main.mjs`) with a
Node 22.18+ binary, or `ELECTRON_RUN_AS_NODE=1` with the app binary. See
`packages/mcp/README.md` for the shipped config and the tool list.

## Service build for the desktop shell

```bash
pnpm --filter @ballast/agent build:service
```

Writes `apps/agent/dist-service/`:

```
main.mjs           bundled `ballast` CLI (`main.mjs serve` runs the service)
plan-worker.mjs    bundled planner worker (main.mjs points at it)
web/               copy of apps/web/dist, or a placeholder page
version.json       { "version": "..." }
node_modules/      effect, ws, rolldown + native binding, uiohook-napi and
                   @julusian/midi (with prebuilds), and @ballast/* source used
                   by runtime script bundling and the plan worker
```

The native `rolldown` package is deliberately external to the bundle and copied with its
`@rolldown/*` binding, because script bundles are produced at runtime. Run the stage with
`ELECTRON_RUN_AS_NODE=1 <electron> <stage>/main.mjs serve` (the desktop launcher spawns this detached).
`BALLAST_STATE_DIR`, `BALLAST_DATA_DIR`, `BALLAST_LOG_DIR`, `BALLAST_SERVICE_PORT` and
`BALLAST_SERVICE_VERSION` are honoured.

## Shell permissions and approvals

The desktop shell owns macOS Accessibility (`systemPreferences.isTrustedAccessibilityClient`) and
reports it with `ReportShellPermission`; `GetHealth.permissions.accessibility` and the keyboard
connection's `approval` reflect it. VTube Studio's Allow dialog uses the same
`ConnectionSummary.approval` flag with `kind: "vtuber-studio"` and leaves the status `connecting`
rather than `reauth-required`.

The desktop main process uses Node's global WebSocket, so it authenticates the RPC upgrade with
`/rpc?token=...`; the CLI continues to use `Authorization: Bearer`. `/health` stays
unauthenticated and other HTTP routes keep cookie/header auth.

## Durable timers

A script declares a timer in init (`Ballast.Timer.subscribe`), schedules instances from handlers
or `Ballast.run`, and handles each fire as an event. The service stores each project's instances
in `<project>/.ballast/timers.json`; writes are atomic 0600 and serialized per project, and a
corrupt file is renamed to `timers.json.corrupt-<timestamp>` before starting empty. Pending
instances survive stop/disable and service restarts; a fire is persisted as `fired` before it is
posted to the active worker generation (at-most-once). A changed payload fingerprint or a removed
declaration drops pending instances with `timer-schema-changed` / `timer-declaration-removed`.
Identity is project + timer name + key; the script id is retained as metadata for the transition
to decision 0008's one-bundle projects.

Projects with `ballast.ts` (or `package.json#ballast.entry`) run as one bundle and one
worker through `ProjectRuntime`. File changes are planned with the `tsgo` gate, diffed by unit
kind/name, and either applied straight away or held behind one project consent. A failed
typecheck/bundle/plan keeps the previous worker and records the file/line; a successful cutover
starts the new worker before the old one is closed after a 30s grace period.

`CreateProject` scaffolds `ballast.ts`, `package.json`, `tsconfig.json` and `AGENTS.md`
(never into a non-empty folder). The base directory is `BALLAST_PROJECTS_DIR`, defaulting to
`<home>/ballast-projects`. `CheckProject` runs the typecheck/bundle/plan/diff gate without
applying; the shipped service includes `tsgo`, `@types/node` and the Ballast/effect sources.

The worker-facing RPCs are `RegisterTimer`, `ScheduleTimer` and `CancelTimer`. The public
`AgentRpcs` surface adds `ListTimers`, `CancelTimer`, `ScriptManifest.timers` and the
`timer-fired` service event. `ballast run` keeps timers in memory; the service is the durable
path.
