import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DesktopConfig } from "../config.ts";
import type { Stage } from "./types.ts";

export interface SpawnedProcess {
  readonly pid: number | undefined;
}

/**
 * Start the service as a detached background process that outlives the UI:
 * its own session/process group, no stdin, output appended to the log dir.
 * ELECTRON_RUN_AS_NODE=1 runs <stage>/main.mjs with Electron's Node.
 */
export async function spawnServiceProcess(config: DesktopConfig, stage: Stage): Promise<SpawnedProcess> {
  await mkdir(config.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(path.join(config.logDir, "service.log"), "a", 0o600);
  const stderr = openSync(path.join(config.logDir, "service.err.log"), "a", 0o600);
  const env: Record<string, string> = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    BALLAST_STATE_DIR: config.stateDir,
    BALLAST_DATA_DIR: config.dataDir,
    BALLAST_LOG_DIR: config.logDir,
  };
  if (config.servicePort !== undefined) env["BALLAST_SERVICE_PORT"] = String(config.servicePort);

  try {
    const child = spawn(config.execPath, ["--no-warnings=ExperimentalWarning", stage.entry, "serve"], {
      cwd: stage.directory,
      env,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
}

const signal = (pid: number, name: NodeJS.Signals): void => {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
};

export function terminateProcess(pid: number): void {
  signal(pid, "SIGTERM");
}

export function killProcess(pid: number): void {
  signal(pid, "SIGKILL");
}
