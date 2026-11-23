# @ballast/mcp

A local stdio MCP server that lets a coding agent author Ballast projects and
then verify and run them. It is an MCP **client of the running Ballast
service**: it discovers `service.json`, reuses the service bearer token, and
proxies runtime calls over the same WebSocket RPC (`AgentRpcs`) as the CLI.

The server does not start Ballast. If no service is running, every project tool
returns a clear "Ballast is not running" error.

## Run

```sh
# from the repo
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  packages/mcp/src/bin.ts [--state-dir <dir>] [--data-dir <dir>] [--url <url> --token <token>]

# once installed/linked
ballast-mcp
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
          "/absolute/path/to/ballast/packages/mcp/src/bin.ts"
        ],
        "timeout": {
          "startup": 20000
        }
      }
    }
  }
}
```

Set `BALLAST_STATE_DIR` / `BALLAST_DATA_DIR` under `environment` only when
using a non-default install. In a packaged build the command becomes
`["ballast", "mcp"]` after the follow-up wiring below.

## Tools

| Tool | Input | What it does |
| --- | --- | --- |
| `ballast_guide` | none | The authoring contract: imports, entry and modules, params, connections, named subscribe/run, Twitch scopes, durable timers, init/handlers, plan/apply/consent, an example. |
| `ballast_catalog` | `integration?`, `kind?`, `search?`, `includeSchemas?`, `limit?` | Integration index by default; topics (event JSON Schemas), requests (input/output schemas and scopes) and connection kinds when narrowed. Schemas come from the integration packages' exported Effect Schemas. |
| `ballast_project_init` | `dir`, `name?` | Scaffolds `ballast.ts`, `package.json`, `tsconfig.json` and `AGENTS.md`, then registers the folder with the service. Never overwrites existing files. |
| `ballast_check` | `project` | Typecheck + bundle + plan **without applying**. Returns structured diagnostics (`file`, `line`, `column`, TS code, message), units with project-relative sources, diff against applied, `requiresConsent`, missing connections and scopes. |
| `ballast_apply` | `project` | Requests a reload of a running, already-approved project. Consent, missing connections/scopes and the first Start are user-only; returns `waiting_for_user` with the action. Never calls approve/start. |
| `ballast_status` | `project?` | Service health and project state: running, waiting for consent, previous-version-running-latest-failed, error, stopped; per-unit status/source; missing connections/scopes. |
| `ballast_logs` | `project`, `unit?`, `since?`, `limit?` | A bounded log snapshot; `since` is epoch ms, ISO, or `10m`/`2h`. |
| `ballast_events` | `project`, `unit?`, `integration?`, `topic?`, `since?`, `limit?` | A bounded inbound/outbound event snapshot with truncated payloads. |

`project` accepts a project id, a display name, or an absolute folder path.
Results are compact text plus `structuredContent` JSON.

## Adapter contract for W4

The project tools sit behind `ProjectAdapter` in `src/adapter.ts`. The current
implementation resolves the project and runtime state over RPC, then runs the
**non-applying** planner locally (`planProject`, `typecheckProject`,
`diffProject`) so `ballast_check` has structured diagnostics and cannot apply
anything.

If the service is remote (`BALLAST_SERVICE_URL`) and the project root is not
readable by the MCP process, `check` falls back to the `PlanProject` RPC. W4
must make that RPC read-only before that path is used in practice.

The final service API should satisfy this shape (or the equivalent RPCs):

```ts
interface ProjectAdapter {
  listProjects(): Effect<ProjectSummary[], ToolError>;
  resolveProject(ref: string): Effect<ProjectSummary, ToolError>;
  getProject(projectId: string): Effect<ProjectDetail, ToolError>;
  registerProject(path: string, name?: string): Effect<ProjectDetail, ToolError>;
  checkProject(project: ProjectSummary): Effect<CheckResult, ToolError>;
  restartProject(projectId: string): Effect<ProjectDetail, ToolError>;
  listConnections(): Effect<ConnectionSummary[], ToolError>;
  health(): Effect<HealthStatus, ToolError>;
  logs(request: StreamLogsRequest, take: number): Effect<LogEntry[], ToolError>;
  events(request: StreamEventsRequest, take: number): Effect<EventRecord[], ToolError>;
}
```

`checkProject` must be read-only and return:

```ts
interface CheckResult {
  project: ProjectSummary;
  entry: string;
  ok: boolean;
  error?: string;
  diagnostics: { file; line; column; code?; message }[];
  units: { kind; name; source?; detail }[];
  changes: { kind; name; change: "added" | "removed" | "changed"; source? }[];
  requiresConsent: boolean;
  missingConnections: { integration; slot; location; connectionId?; status? }[];
  missingScopes: { integration; slot; connectionId?; scopes }[];
  appliedAt?: number;
  pendingConsent?: { id; reason; summary };
}
```

Specifically, W4 should:

- make `PlanProject` non-applying and add diagnostics (or add a
  `CheckProject`/`PlanProjectPreview` RPC);
- always return `appliedManifest` in `ProjectDetail` (today the MCP falls back
  to `manifest` when `appliedAt` is set);
- expose project/unit `source` locations that are project-relative; core frames
  such as `../../core/src/timer.ts` are currently filtered out by the MCP;
- keep `StartProject`/`ApproveProjectConsent` user-only. The MCP deliberately
  never calls them.

Swapping the local planner for the final RPC is a single change in
`makeProjectAdapter`'s `checkProject`; the tool layer does not change.

## Wiring `ballast mcp` into the agent CLI (not done this round)

`packages/mcp` exports `runMcpCli` for exactly this. The change in
`apps/agent/src/bin.ts` is:

1. Add to `usage`: `ballast mcp [--state-dir <dir>] [--data-dir <dir>]`.
2. Add a branch before `serve`:

```ts
if (command === "mcp") {
  yield* Effect.tryPromise({
    try: () => runMcpCli({
      args: rest,
      env: process.env,
      platform: process.platform,
      home: process.env["HOME"] ?? process.cwd(),
    }),
    catch: (cause) => new Error(formatError(cause)),
  });
  return;
}
```

3. Import `runMcpCli` from `@ballast/mcp` and add
   `"@ballast/mcp": "workspace:*"` to `apps/agent/package.json`.

The MCP server must own stdout, so the CLI must not print a banner before it.
The `ballast-mcp` bin stays available for direct use and tests.

## Tests

```sh
pnpm --filter @ballast/mcp typecheck
pnpm --filter @ballast/mcp test
```

The E2E test starts the real `ballast serve` with throwaway state/data
directories, spawns the real MCP server over stdio, and calls `ballast_catalog`,
`ballast_project_init`, `ballast_check` (including a deliberate
`ballast.ts:3:7 TS2322`), `ballast_apply`, `ballast_status`, logs and events.
