import { Schema } from "effect";

/**
 * Coding agents that can author a project through the Ballast MCP server.
 * Each one reads a project-local config file, so the server is only
 * connected when the agent is started inside the project folder.
 */
export const CodingAgent = Schema.Literals(["opencode", "claude-code", "codex"]);
export type CodingAgent = typeof CodingAgent.Type;

export const CODING_AGENTS: ReadonlyArray<CodingAgent> = ["opencode", "claude-code", "codex"];

/** Project-relative config file each agent reads its MCP servers from. */
export const CODING_AGENT_CONFIG_FILES: Readonly<Record<CodingAgent, string>> = {
  opencode: "opencode.json",
  "claude-code": ".mcp.json",
  codex: ".codex/config.toml",
};

/** The MCP server's name in every generated config. */
export const BALLAST_MCP_SERVER_NAME = "ballast";

/**
 * How an agent starts the Ballast MCP server: a launcher the service
 * rewrites on every start, so configs survive app and service updates.
 */
export const McpLaunchCommand = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
});
export type McpLaunchCommand = typeof McpLaunchCommand.Type;

export const ProjectAgentConfig = Schema.Struct({
  agent: CodingAgent,
  /** Project-relative path of the config file. */
  file: Schema.String,
  /** The file has a `ballast` server that starts this service's launcher. */
  configured: Schema.Boolean,
});
export type ProjectAgentConfig = typeof ProjectAgentConfig.Type;

export const ProjectAgentSetup = Schema.Struct({
  projectId: Schema.String,
  root: Schema.String,
  launcher: McpLaunchCommand,
  agents: Schema.Array(ProjectAgentConfig),
});
export type ProjectAgentSetup = typeof ProjectAgentSetup.Type;

/** The CLI each agent starts with in a terminal. */
export const CODING_AGENT_COMMANDS: Readonly<Record<CodingAgent, string>> = {
  opencode: "opencode",
  "claude-code": "claude",
  codex: "codex",
};

/**
 * Apps the service can open a project folder in. Only the installed ones
 * are listed for a project; terminals that `runsAgents` can also start a
 * coding agent's CLI in the folder.
 */
export const ProjectOpener = Schema.Literals([
  "opencode-desktop",
  "terminal",
  "iterm",
  "ghostty",
  "warp",
  "vscode",
  "cursor",
  "zed",
  "files",
]);
export type ProjectOpener = typeof ProjectOpener.Type;

export const ProjectOpenerKind = Schema.Literals(["agent", "terminal", "editor", "files"]);
export type ProjectOpenerKind = typeof ProjectOpenerKind.Type;

export const ProjectOpenerInfo = Schema.Struct({
  opener: ProjectOpener,
  name: Schema.String,
  kind: ProjectOpenerKind,
  /** The opener can start a coding agent's CLI in the folder. */
  runsAgents: Schema.Boolean,
  /** The agent an `agent` app runs, such as OpenCode for OpenCode Desktop. */
  agent: Schema.optionalKey(CodingAgent),
});
export type ProjectOpenerInfo = typeof ProjectOpenerInfo.Type;

export const ProjectOpeners = Schema.Struct({
  projectId: Schema.String,
  openers: Schema.Array(ProjectOpenerInfo),
  /** Agents whose project-local config starts the Ballast MCP server. */
  configuredAgents: Schema.Array(CodingAgent),
});
export type ProjectOpeners = typeof ProjectOpeners.Type;

export const OpenProjectRequest = Schema.Struct({
  projectId: Schema.String,
  opener: ProjectOpener,
  /** Start this agent's CLI in the folder; only for openers that `runsAgents`. */
  agent: Schema.optionalKey(CodingAgent),
});
export type OpenProjectRequest = typeof OpenProjectRequest.Type;

export const WriteProjectAgentConfigsRequest = Schema.Struct({
  projectId: Schema.String,
  /** Add or update the `ballast` server in these agents' configs; other settings are kept. */
  agents: Schema.Array(CodingAgent),
});
export type WriteProjectAgentConfigsRequest = typeof WriteProjectAgentConfigsRequest.Type;
