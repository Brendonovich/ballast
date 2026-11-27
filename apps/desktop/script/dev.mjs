#!/usr/bin/env node
// Starts Vite for UI HMR, builds the service/shell once, and starts Electron.
// Pass --background to start in the tray, or BALLAST_VITE_DEV=0 to use the built UI.
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
const repoRoot = path.resolve(root, "..", "..");
const webRoot = path.join(repoRoot, "apps", "web");
const webRequire = createRequire(path.join(webRoot, "package.json"));
const viteBin = path.join(path.dirname(webRequire.resolve("vite/package.json")), "bin", "vite.js");

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

const autoVite =
  process.env.BALLAST_UI_URL === undefined && process.env.BALLAST_VITE_DEV !== "0";
const devUi = autoVite || process.env.BALLAST_UI_URL !== undefined;
if (autoVite) process.env.BALLAST_UI_URL = "http://127.0.0.1:5173";

await buildAgentService({ web: !devUi });
await buildDesktop({ minify: false });

const exited = (process) => process.exitCode !== null || process.signalCode !== null;
const stopProcess = async (process) => {
  if (process === undefined || exited(process)) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(force);
      clearTimeout(done);
      resolve();
    };
    const force = setTimeout(() => {
      if (!exited(process)) process.kill("SIGKILL");
    }, 2_000);
    const done = setTimeout(finish, 4_000);
    process.once("exit", finish);
    process.kill("SIGTERM");
  });
};

let vite;
let child;
let finishing = false;
const finish = async (code) => {
  if (finishing) return;
  finishing = true;
  // Do not exit until both direct children are gone; an immediate restart must
  // never race a Vite process that still owns the port.
  await Promise.all([stopProcess(vite), stopProcess(child)]);
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void finish(0));
}

if (autoVite) {
  // Spawn Vite itself, not pnpm: killing a pnpm wrapper leaves the actual
  // server behind holding port 5173 after Electron quits.
  vite = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    { cwd: webRoot, stdio: "inherit", env: process.env },
  );
  vite.on("exit", (code) => {
    if (!finishing) {
      console.error("[desktop] Vite stopped; closing Electron");
      void finish(code ?? 1);
    }
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited(vite)) throw new Error("Vite exited before becoming ready");
    try {
      const response = await fetch(process.env.BALLAST_UI_URL, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    if (Date.now() >= deadline) {
      await stopProcess(vite);
      throw new Error("Timed out waiting for Vite at " + process.env.BALLAST_UI_URL);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

child = spawn(electron, [".", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => void finish(code ?? 0));
