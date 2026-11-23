import { rm } from "node:fs/promises";

import { readRealServiceInfo, realServiceInfoPath } from "./real-service.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const waitForExit = async (pid: number, timeout = 5_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
};

export default async function globalTeardown(): Promise<void> {
  const info = readRealServiceInfo();
  if (info === undefined) return;
  try {
    await fetch(new URL("/shutdown", info.url), {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
    });
  } catch {
    // Fall through to signalling the pid.
  }
  await waitForExit(info.pid);
  await rm(info.projectPath, { recursive: true, force: true });
  await rm(info.tempRoot, { recursive: true, force: true });
  await rm(realServiceInfoPath, { force: true });
  console.log("[real-service e2e] service stopped");
}
