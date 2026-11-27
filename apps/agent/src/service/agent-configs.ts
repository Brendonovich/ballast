import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  BALLAST_MCP_SERVER_NAME,
  CODING_AGENTS,
  CODING_AGENT_CONFIG_FILES,
  agentError,
  type AgentError,
  type CodingAgent,
  type ProjectAgentSetup,
} from "@ballast/agent-protocol";
import { isNotFound } from "./fs.ts";

/**
 * Project-local coding agent configs that start the Ballast MCP server.
 *
 * Configs never name a versioned service build. They start a launcher in
 * the data directory that the service rewrites on every start with its own
 * runtime, entry and state/data directories, so a config written once keeps
 * working across app and service updates and with non-default installs.
 */

export const MCP_LAUNCHER_NAME = "ballast-mcp";

export const mcpLauncherPath = (path: Path.Path, dataDir: string): string =>
  path.join(dataDir, "bin", process.platform === "win32" ? MCP_LAUNCHER_NAME + ".cmd" : MCP_LAUNCHER_NAME);

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

const cmdQuote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

/** How this service process was started, so the launcher can start `<entry> mcp` the same way. */
const selfCommand = (): {
  readonly runtime: string;
  readonly runtimeArgs: ReadonlyArray<string>;
  readonly entry: string;
  readonly electron: boolean;
} => ({
  runtime: process.execPath,
  runtimeArgs: process.execArgv.filter((arg) => !arg.startsWith("--inspect")),
  entry: process.argv[1] ?? "",
  electron: process.versions["electron"] !== undefined,
});

const launcherScript = (input: { readonly stateDir: string; readonly dataDir: string }): string => {
  const self = selfCommand();
  const env: ReadonlyArray<readonly [string, string]> = [
    ...(self.electron ? ([["ELECTRON_RUN_AS_NODE", "1"]] as const) : []),
    ["BALLAST_STATE_DIR", input.stateDir],
    ["BALLAST_DATA_DIR", input.dataDir],
  ];
  const argv = [self.runtime, ...self.runtimeArgs, self.entry, "mcp"];
  if (process.platform === "win32") {
    return [
      "@echo off",
      "rem Starts the Ballast MCP server. The Ballast service rewrites this file when it starts.",
      ...env.map(([key, value]) => `set "${key}=${value}"`),
      argv.map(cmdQuote).join(" ") + " %*",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Starts the Ballast MCP server. The Ballast service rewrites this file when it starts.",
    ...env.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    "exec " + argv.map(shellQuote).join(" ") + ' "$@"',
    "",
  ].join("\n");
};

/** Write (or refresh) the MCP launcher; returns its path. */
export const ensureMcpLauncher = (input: {
  readonly stateDir: string;
  readonly dataDir: string;
}): Effect.Effect<string, AgentError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = mcpLauncherPath(path, input.dataDir);
    const script = launcherScript(input);
    const current = yield* fs.readFileString(target).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (current === script) return target;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      const temp = target + ".tmp-" + process.pid;
      yield* fs.writeFileString(temp, script);
      yield* fs.chmod(temp, 0o755);
      yield* fs.rename(temp, target);
    }).pipe(
      Effect.mapError((cause) =>
        agentError("internal", "Could not write the Ballast MCP launcher: " + cause.message),
      ),
    );
    return target;
  });

// ---- per-agent config files ----

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectAt = (parent: JsonObject, key: string): JsonObject => {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
};

interface JsonAgentFormat {
  readonly kind: "json";
  /** Object keys from the root to the map of named servers. */
  readonly serversPath: ReadonlyArray<string>;
  readonly entry: (launcher: string) => JsonObject;
  readonly command: (entry: JsonObject) => unknown;
  readonly seed?: JsonObject;
}

interface TomlAgentFormat {
  readonly kind: "toml";
}

const formats: Readonly<Record<CodingAgent, JsonAgentFormat | TomlAgentFormat>> = {
  // https://opencode.ai/docs/mcp-servers (V2: servers live under mcp.servers)
  opencode: {
    kind: "json",
    serversPath: ["mcp", "servers"],
    seed: { $schema: "https://opencode.ai/config.json" },
    entry: (launcher) => ({ type: "local", command: [launcher], timeout: { startup: 30_000 } }),
    command: (entry) => (Array.isArray(entry["command"]) ? entry["command"][0] : undefined),
  },
  // https://docs.claude.com/en/docs/claude-code/mcp (project scope)
  "claude-code": {
    kind: "json",
    serversPath: ["mcpServers"],
    entry: (launcher) => ({ type: "stdio", command: launcher, args: [] }),
    command: (entry) => entry["command"],
  },
  // https://developers.openai.com/codex/mcp (project-scoped .codex/config.toml)
  codex: { kind: "toml" },
};

const tomlString = (value: string): string => JSON.stringify(value);

const tomlHeader = /^\s*\[\s*mcp_servers\s*\.\s*(?:ballast|"ballast")\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const anyHeader = /^\s*\[/;

/** Lines of the `[mcp_servers.ballast]` table and its subtables, as [start, end) runs. */
const tomlBallastRuns = (lines: ReadonlyArray<string>): ReadonlyArray<readonly [number, number]> => {
  const runs: Array<readonly [number, number]> = [];
  let start: number | undefined;
  lines.forEach((line, index) => {
    if (!anyHeader.test(line)) return;
    const ours = tomlHeader.test(line);
    if (ours && start === undefined) start = index;
    if (!ours && start !== undefined) {
      runs.push([start, index]);
      start = undefined;
    }
  });
  if (start !== undefined) runs.push([start, lines.length]);
  return runs;
};

const tomlConfigured = (text: string, launcher: string): boolean => {
  const lines = text.split(/\r?\n/);
  const expected = "command = " + tomlString(launcher);
  return tomlBallastRuns(lines).some(([start, end]) =>
    lines.slice(start, end).some((line) => line.trim().replace(/\s*=\s*/, " = ") === expected),
  );
};

const tomlWithBallast = (text: string, launcher: string): string => {
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  const drop = new Set<number>();
  for (const [start, end] of tomlBallastRuns(lines)) {
    for (let index = start; index < end; index++) drop.add(index);
  }
  const kept = lines.filter((_, index) => !drop.has(index));
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
  const block = [
    `[mcp_servers.${BALLAST_MCP_SERVER_NAME}]`,
    "command = " + tomlString(launcher),
    "args = []",
    "startup_timeout_sec = 30",
  ];
  return [...kept, ...(kept.length === 0 ? [] : [""]), ...block, ""].join("\n");
};

const jsonServers = (root: JsonObject, format: JsonAgentFormat): JsonObject | undefined => {
  let current: unknown = root;
  for (const key of format.serversPath) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return isObject(current) ? current : undefined;
};

const parseJsonConfig = (file: string, text: string): Effect.Effect<JsonObject, AgentError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () =>
      agentError(
        "conflict",
        `${file} is not plain JSON (comments or trailing commas?). Add the "${BALLAST_MCP_SERVER_NAME}" server by hand.`,
      ),
  }).pipe(
    Effect.flatMap((value) =>
      isObject(value)
        ? Effect.succeed(value)
        : Effect.fail(agentError("conflict", `${file} does not contain a JSON object`)),
    ),
  );

const readOptional = (
  target: string,
): Effect.Effect<string | undefined, AgentError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(target).pipe(
      Effect.catchIf(
        (cause) => isNotFound(cause),
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((cause) => agentError("internal", `Could not read ${target}: ${cause.message}`)),
    ),
  );

const isConfigured = (
  agent: CodingAgent,
  text: string | undefined,
  launcher: string,
): boolean => {
  if (text === undefined) return false;
  const format = formats[agent];
  if (format.kind === "toml") return tomlConfigured(text, launcher);
  try {
    const root: unknown = JSON.parse(text);
    if (!isObject(root)) return false;
    const entry = jsonServers(root, format)?.[BALLAST_MCP_SERVER_NAME];
    return isObject(entry) && format.command(entry) === launcher;
  } catch {
    return false;
  }
};

export const projectAgentSetup = (input: {
  readonly projectId: string;
  readonly root: string;
  readonly launcher: string;
}): Effect.Effect<ProjectAgentSetup, AgentError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const agents = yield* Effect.forEach(CODING_AGENTS, (agent) =>
      Effect.map(readOptional(path.join(input.root, CODING_AGENT_CONFIG_FILES[agent])), (text) => ({
        agent,
        file: CODING_AGENT_CONFIG_FILES[agent],
        configured: isConfigured(agent, text, input.launcher),
      })),
    );
    return {
      projectId: input.projectId,
      root: input.root,
      launcher: { command: input.launcher, args: [] },
      agents,
    };
  });

const writeAgentConfig = (input: {
  readonly root: string;
  readonly agent: CodingAgent;
  readonly launcher: string;
}): Effect.Effect<void, AgentError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = CODING_AGENT_CONFIG_FILES[input.agent];
    const target = path.join(input.root, file);
    const existing = yield* readOptional(target);
    const format = formats[input.agent];
    let next: string;
    if (format.kind === "toml") {
      next = tomlWithBallast(existing ?? "", input.launcher);
    } else {
      const root = existing === undefined ? { ...format.seed } : yield* parseJsonConfig(file, existing);
      let servers = root;
      for (const key of format.serversPath) servers = objectAt(servers, key);
      servers[BALLAST_MCP_SERVER_NAME] = format.entry(input.launcher);
      next = JSON.stringify(root, null, 2) + "\n";
    }
    if (next === existing) return;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, next);
    }).pipe(Effect.mapError((cause) => agentError("internal", `Could not write ${file}: ${cause.message}`)));
  });

export const writeProjectAgentConfigs = (input: {
  readonly projectId: string;
  readonly root: string;
  readonly launcher: string;
  readonly agents: ReadonlyArray<CodingAgent>;
}): Effect.Effect<ProjectAgentSetup, AgentError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    for (const agent of new Set(input.agents)) {
      yield* writeAgentConfig({ root: input.root, agent, launcher: input.launcher });
    }
    return yield* projectAgentSetup(input);
  });

/**
 * Agent configs name this machine's launcher by absolute path, so a share
 * leaves out the ones that start it; subscribers write their own.
 */
export const isMachineAgentConfig = (path: string, bytes: Uint8Array): boolean =>
  Object.values(CODING_AGENT_CONFIG_FILES).includes(path) &&
  new TextDecoder().decode(bytes).includes(MCP_LAUNCHER_NAME);
