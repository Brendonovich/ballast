#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
import { runMcpCli } from "./cli.ts";

const main = async (): Promise<void> => {
  try {
    await runMcpCli({
      args: process.argv.slice(2),
      env: process.env,
      platform: process.platform,
      home: process.env["HOME"] ?? process.cwd(),
    });
  } catch (cause) {
    process.stderr.write(
      "ballast-mcp: " + (cause instanceof Error ? cause.message : String(cause)) + "\n",
    );
    process.exitCode = 1;
  }
};

void main();
