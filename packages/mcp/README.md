# @ballast/mcp

A local stdio MCP server that lets a coding agent author Ballast projects and
then verify and run them. It is an MCP **client of the running Ballast
service**: it discovers `service.json`, reuses the service bearer token, and
proxies every project/tool call over the same WebSocket RPC (`AgentRpcs`) as
the CLI.

The server does not start Ballast. If no service is running, every project tool
returns a clear "Ballast is not running" error.

## Run

Dev, through the agent CLI (the supported path):

```sh
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  apps/agent/src/bin.ts mcp [--state-dir <dir>] [--data-dir <dir>] [--url <url> --token <token>]
```

The standalone bin (also useful for testing the package alone) is
`node packages/mcp/src/bin.ts` or `ballast-mcp`.

Shipped, from a staged service build:

```sh
node /path/to/Ballast/service/<version>/main.mjs mcp
# or, when running the Electron Node:
ELECTRON_RUN_AS_NODE=1 /Applications/Ballast.app/Contents/MacOS/Ballast \
  /path/to/Ballast/service/<version>/main.mjs mcp
```

Discovery order:

1. `--url` / `--token` or `BALLAST_SERVICE_URL` + `BALLAST_SERVICE_TOKEN`
   (loopback only).
2. `--state-dir` / `BALLAST_STATE_DIR`, then `<data-dir>/state` and
   `<data-dir>` for `--data-dir` / `BALLAST_DATA_DIR`.
3. The agent defaults: `$XDG_STATE_HOME/ballast` or
   `~/.local/state/ballast` (macOS/Linux), `%LOCALAPPDATA%\Ballast\state`
   (Windows); data under `$XDG_DATA_HOME/ballast` or `~/.local/share/ballast`
   / `%LOCALAPPDATA%\Ballast`.
4. Desktop app-support fallbacks on macOS
   (`~/Library/Application Support/Ballast/state`).

The URL must be loopback. Every candidate is verified through the
unauthenticated `/health` endpoint before use, so a crash leaves a stale
`service.json` but produces a useful error instead of a dead socket.

## OpenCode configuration (V2)

Dev, from a checkout:

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
        ],
        "timeout": {
          "startup": 20000
        }
      }
    }
  }
}
```

Shipped: point at the staged service's `main.mjs` (or use `ballast mcp` when
the CLI is on `PATH`). The desktop app stages the same file under
`<userData>/service/<version>/main.mjs`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "ballast": {
        "type": "local",
        "command": [
          "node",
          "/Users/you/Library/Application Support/dev.ballast.agent/service/0.1.0/main.mjs",
          "mcp"
        ],
        "timeout": {
          "startup": 30000
        }
      }
    }
  }
}
```

Set `BALLAST_STATE_DIR` / `BALLAST_DATA_DIR` under `environment` only when
using a non-default install. For an Electron-shipped start, set
`ELECTRON_RUN_AS_NODE=1` and use the app binary as the executable.

## Tools

| Tool | Input | What it does |
| --- | --- | --- |
| `ballast_guide` | none | The authoring contract: imports, entry and modules, params, connections, named subscribe/run, Twitch scopes, durable timers, init/handlers, plan/apply/consent, an example. |
| `ballast_catalog` | `integration?`, `kind?`, `search?`, `topic?`, `request?`, `includeSchemas?`, `limit?`, `offset?` | Integration index by default; topics (event JSON Schemas), requests (input/output schemas and scopes) and connection kinds when narrowed. Results state when they are truncated and page with `offset`. Schemas come from the integration packages' exported Effect Schemas. |
| `ballast_project_init` | `name`, `dir?` | Calls the service's `CreateProject`: writes `ballast.ts`, `package.json`, `tsconfig.json` and `AGENTS.md`, then reports the actual file list from `ListProjectFiles`. The service refuses a non-empty folder. Does not start it. |
| `ballast_check` | `project` | Calls the service's non-applying `CheckProject`. Returns structured diagnostics (`file`, `line`, `column`, code, message), units with project-relative sources, changes, `requiresConsent`, every requirement as bound/proposed/unbound/missing, missing scopes, `appliedManifest` and pending consent. |
| `ballast_apply` | `project` | Requests a reload of a running, already-approved project. Consent, connection bindings and the first Start are user-only; returns `waiting_for_user` with `reason: "connections"` and the unbound slots when requirements are not bound. Never binds, approves or starts. |
| `ballast_status` | `project?` | Service health and project state: `running`, `waiting_for_user` (with reason), `previous_version_running_latest_failed`, `error`, `stopped`; per-unit status/source; requirements (bound/proposed/unbound/missing) and missing scopes. |
| `ballast_logs` | `project`, `unit?`, `since?`, `limit?` | A bounded log snapshot. `unit` accepts `name` or `kind:name`; the RPC receives both `unitKind` and `unitName`. |
| `ballast_events` | `project`, `unit?`, `integration?`, `topic?`, `since?`, `limit?` | A bounded inbound/outbound event snapshot with truncated payloads; same project/unit filters. |

`project` accepts a project id, a display name, or an absolute folder path.
Results are compact text plus `structuredContent` JSON.

## Adapter

All project work is service-side; the MCP has no planner dependency:

```ts
interface ProjectAdapter {
  listProjects(): Effect<ProjectSummary[], ToolError>;
  resolveProject(ref: string): Effect<ProjectSummary, ToolError>;
  getProject(projectId: string): Effect<ProjectDetail, ToolError>;
  createProject(name: string, directory?: string): Effect<ProjectDetail, ToolError>;
  checkProject(projectId: string): Effect<ProjectCheckResult, ToolError>;
  restartProject(projectId: string): Effect<ProjectDetail, ToolError>;
  listConnections(): Effect<ConnectionSummary[], ToolError>;
  health(): Effect<HealthStatus, ToolError>;
  logs(request: StreamLogsRequest, take: number): Effect<LogEntry[], ToolError>;
  events(request: StreamEventsRequest, take: number): Effect<EventRecord[], ToolError>;
}
```

`createProject` maps to `CreateProject({ name, directory })`;
`checkProject` maps to `CheckProject({ projectId })`. Slots are project-local;
connection instances are service-level. The MCP never calls `StartProject`,
`ApproveProjectConsent` or `SetProjectBinding`.

## CLI wiring

`ballast mcp` is wired in `apps/agent/src/bin.ts`:

```ts
if (command === "mcp") {
  yield* Effect.tryPromise({
    try: async () => {
      const mcp = await import("@ballast/mcp");
      await mcp.runMcpCli({
        args: rest,
        env: process.env,
        platform: process.platform,
        home: process.env["HOME"] ?? process.cwd(),
      });
    },
    catch: (cause) => new Error(formatError(cause)),
  });
  return;
}
```

The MCP owns stdout, so the CLI prints no banner before it. The service build
(`pnpm --filter @ballast/agent build:service`) bundles the MCP into
`dist-service/main.mjs`, so `main.mjs mcp` works from the staged service.

## Tests

```sh
pnpm --filter @ballast/mcp typecheck
pnpm --filter @ballast/mcp test
```

The E2E test starts the real `ballast serve` with throwaway state/data
directories, spawns `apps/agent/src/bin.ts mcp` over stdio, and calls
`ballast_catalog`, `ballast_project_init`, `ballast_check` (including a
deliberate `ballast.ts:3:7 TS2322`), `ballast_apply`, `ballast_status`,
logs and events.
