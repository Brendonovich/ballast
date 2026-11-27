#!/usr/bin/env node
// Builds the real agent service stage (apps/agent/dist-service) and the web UI
// it serves. Desktop dev/pack both call this; only the unit tests point at
// dev/stub-service.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(desktopRoot, "..", "..");
export const agentRoot = path.join(repoRoot, "apps", "agent");

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    // pnpm is pnpm.cmd on Windows, which only a shell runs.
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + " " + args.join(" ") + " exited with " + code));
    });
  });

/** `BALLAST_SERVICE_SKIP_BUILD=1` reuses an existing dist-service. */
export async function buildAgentService(options = {}) {
  if (process.env.BALLAST_SERVICE_SKIP_BUILD === "1") {
    console.log("[desktop] reusing existing agent service build");
    return;
  }
  if (options.web !== false && process.env.BALLAST_SERVICE_SKIP_WEB_BUILD !== "1") {
    await run("pnpm", ["--filter", "@ballast/web", "build"], repoRoot);
  }
  await run(process.execPath, [path.join(agentRoot, "scripts", "build-service.mjs")], repoRoot);
}
