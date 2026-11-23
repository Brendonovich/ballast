import { configForUsage, configSummary, parseConfig } from "./config.ts";
import { runServer } from "./server.ts";

export const MCP_VERSION = "0.1.0";

export interface CliInput {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

/**
 * Run the stdio MCP server. This is the function `ballast mcp` calls once it is
 * wired into the agent CLI; it never forks or prints to stdout except MCP
 * frames (diagnostics go to stderr).
 */
export const runMcpCli = async (input: CliInput): Promise<void> => {
  if (input.args.includes("--version")) {
    process.stdout.write("ballast-mcp " + MCP_VERSION + "\n");
    return;
  }
  if (input.args.includes("--help") || input.args.includes("-h")) {
    process.stdout.write(configForUsage() + "\n");
    return;
  }
  const config = parseConfig({
    args: input.args,
    env: input.env,
    platform: input.platform,
    home: input.home,
  });
  process.stderr.write("ballast-mcp: " + configSummary(config) + "\n");
  await runServer({
    config,
    env: input.env,
    platform: input.platform,
    home: input.home,
  });
};
