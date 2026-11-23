#!/usr/bin/env node
// Builds once and starts Electron. Pass --background to start in the tray.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktop } from "./build.mjs";
import { buildAgentService } from "./service-build.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/**
 * Load `apps/desktop/.env` for development. Electron passes its environment
 * to the detached service, so a key here (for example `BALLAST_CLOUD_URL`)
 * survives UI restarts; an already-set variable still wins.
 */
const loadDevEnv = (file) => {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

loadDevEnv(path.join(root, ".env"));

await buildAgentService();
await buildDesktop({ minify: false });

const child = spawn(electron, [".", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
