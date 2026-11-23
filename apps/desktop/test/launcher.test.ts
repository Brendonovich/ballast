import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopConfig } from "../src/main/config.ts";
import { createLogger } from "../src/main/logger.ts";
import { createServiceLauncher, type ServiceLauncher } from "../src/main/service/launcher.ts";
import { isProcessAlive } from "../src/main/service/process.ts";
import { configFor } from "./support.ts";

const stubSource = fileURLToPath(new URL("../dev/stub-service", import.meta.url));
const roots: string[] = [];
const launchers: ServiceLauncher[] = [];

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; config: DesktopConfig; build: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ballast-launcher-"));
  roots.push(root);
  const build = path.join(root, "build");
  await cp(stubSource, build, { recursive: true });
  return { root, config: configForBuild(root, build), build };
}

const configForBuild = (root: string, build: string): DesktopConfig =>
  configFor(root, {
    env: {
      BALLAST_SERVICE_BUILD_DIR: build,
      BALLAST_USER_DATA_DIR: path.join(root, "userData"),
      BALLAST_STATE_DIR: path.join(root, "state"),
      BALLAST_DATA_DIR: path.join(root, "data"),
      BALLAST_LOG_DIR: path.join(root, "logs"),
      BALLAST_START_TIMEOUT_MS: "10000",
    },
  });

const launcherFor = (config: DesktopConfig): ServiceLauncher => {
  const launcher = createServiceLauncher(config, {
    logger: createLogger(config.logDir),
    permissions: () => ({ accessibility: "denied" }),
  });
  launchers.push(launcher);
  return launcher;
};

describe("service launcher", () => {
  it("spawns, adopts, restarts and stops a detached stub process", async () => {
    const { config } = await setup();
    const launcher = launcherFor(config);

    const initial = await launcher.status();
    expect(initial).toMatchObject({ phase: "stopped", running: false, permissions: { accessibility: "denied" } });

    const started = await launcher.start();
    expect(started.ok, started.message ?? undefined).toBe(true);
    expect(started.status).toMatchObject({ phase: "running", running: true, runningVersion: "0.0.0-stub.1" });
    expect(started.status.pendingConsents).toBe(1);
    const firstPid = started.status.pid;
    if (firstPid === null) throw new Error("no pid");

    const connection = await launcher.getConnection();
    expect(connection?.url).toBe(started.status.url);
    expect(connection?.token.length).toBeGreaterThan(20);

    // A second launcher (another app window, the CLI) adopts instead of spawning.
    const again = await launcherFor(config).start();
    expect(again.message).toContain("already running");
    expect(again.status.pid).toBe(firstPid);

    const restarted = await launcher.restart();
    expect(restarted.ok, restarted.message ?? undefined).toBe(true);
    expect(restarted.status.running).toBe(true);
    expect(restarted.status.pid).not.toBe(firstPid);
    expect(isProcessAlive(firstPid)).toBe(false);

    const stopped = await launcher.stop();
    expect(stopped.ok, stopped.message ?? undefined).toBe(true);
    expect(stopped.status).toMatchObject({ phase: "stopped", running: false });
  });

  it("replaces a running service of another version with the shipped build", async () => {
    const { root, config, build } = await setup();
    const old = launcherFor(config);
    const first = await old.start();
    expect(first.ok, first.message ?? undefined).toBe(true);
    const oldPid = first.status.pid;
    if (oldPid === null) throw new Error("no pid");

    const nextBuild = path.join(root, "build-next");
    await cp(build, nextBuild, { recursive: true });
    await writeFile(path.join(nextBuild, "version.json"), JSON.stringify({ version: "0.0.0-stub.2" }));
    const next = launcherFor(configForBuild(root, nextBuild));

    const before = await next.status();
    expect(before.updateAvailable).toBe(true);

    const updated = await next.start();
    expect(updated.ok, updated.message ?? undefined).toBe(true);
    expect(updated.message).toContain("updated from 0.0.0-stub.1 to 0.0.0-stub.2");
    expect(updated.status).toMatchObject({ running: true, runningVersion: "0.0.0-stub.2", updateAvailable: false });
    expect(isProcessAlive(oldPid)).toBe(false);
  });
});
