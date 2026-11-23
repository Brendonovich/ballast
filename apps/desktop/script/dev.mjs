#!/usr/bin/env node
// Builds once and starts Electron. Pass --background to start in the tray.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktop } from "./build.mjs";
import { buildAgentService } from "./service-build.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

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
