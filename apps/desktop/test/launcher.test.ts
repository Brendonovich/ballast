import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopConfig } from "../src/main/config.ts";
import { createLogger } from "../src/main/logger.ts";
import { createServiceLauncher } from "../src/main/service/launcher.ts";
import type { ServiceRuntime } from "../src/main/service/runtime.ts";
import { configFor } from "./support.ts";
import type { Stage } from "../src/main/service/types.ts";

const stubSource = fileURLToPath(new URL("../dev/stub-service", import.meta.url));
const roots: string[] = [];
const runtimes: FakeRuntime[] = [];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeRuntime implements ServiceRuntime {
  readonly kind = "launch-agent" as const;
  readonly loginItemPath: string;
  readonly config: DesktopConfig;
  installed = false;
  stage: Stage | null = null;
  child: ChildProcess | null = null;
  stopping = false;

  constructor(config: DesktopConfig) {
    this.config = config;
    this.loginItemPath = path.join(config.userDataDir, "fake-agent.plist");
  }

  async isInstalled(): Promise<boolean> {
    return this.installed;
  }

  async install(stage: Stage): Promise<void> {
    await mkdir(this.config.userDataDir, { recursive: true });
    await writeFile(this.loginItemPath, "fake launch agent");
    this.stage = stage;
    this.installed = true;
  }

  async uninstall(): Promise<void> {
    await this.stop();
    this.installed = false;
    this.stage = null;
    await rm(this.loginItemPath, { force: true });
  }

  async start(): Promise<void> {
    if (!this.installed || this.stage === null) throw new Error("fake runtime is not installed");
    if (this.child !== null) return;
    const child = spawn(process.execPath, [this.stage.entry, "serve", "--standalone"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BALLAST_STATE_DIR: this.config.stateDir,
        BALLAST_DATA_DIR: this.config.dataDir,
        BALLAST_SERVICE_PORT: "0",
      },
      stdio: "ignore",
    });
    this.child = child;
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (code === 75 && this.installed && !this.stopping) {
        setTimeout(() => {
          void this.start().catch(() => undefined);
        }, 50);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      const child = this.child;
      if (child !== null) {
        child.kill("SIGTERM");
        const deadline = Date.now() + 5_000;
        while (this.child !== null && Date.now() < deadline) await delay(20);
        if (this.child !== null) child.kill("SIGKILL");
      }
    } finally {
      this.stopping = false;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ config: DesktopConfig; runtime: FakeRuntime }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ballast-launcher-"));
  roots.push(root);
  const config = configFor(root, {
    env: {
      BALLAST_SERVICE_BUILD_DIR: stubSource,
      BALLAST_USER_DATA_DIR: path.join(root, "userData"),
      BALLAST_STATE_DIR: path.join(root, "state"),
      BALLAST_DATA_DIR: path.join(root, "data"),
      BALLAST_LOG_DIR: path.join(root, "logs"),
      BALLAST_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
    },
  });
  const runtime = new FakeRuntime(config);
  runtimes.push(runtime);
  return { config, runtime };
}

describe("service launcher handoff", () => {
  it("installs, adopts, restarts, stops, starts and uninstalls against a real stub process", async () => {
    const { config, runtime } = await setup();
    const launcher = createServiceLauncher(config, {
      runtime,
      logger: createLogger(config.logDir),
      permissions: () => ({ accessibility: "denied" }),
    });

    await expect(launcher.status()).resolves.toMatchObject({
      permissions: { accessibility: "denied" },
    });

    const installed = await launcher.install();
    expect(installed.ok, installed.message ?? undefined).toBe(true);
    expect(installed.status.installed).toBe(true);
    expect(installed.status.running).toBe(true);
    expect(installed.status.pid).not.toBeNull();
    expect(installed.status.pendingConsents).toBe(1);
    expect(installed.status.installedVersion).toBe("0.0.0-stub.1");
    expect(installed.status.supervisor).toBe("launch-agent");
    await expect(stat(runtime.loginItemPath)).resolves.toBeDefined();

    const firstPid = installed.status.pid;
    const connection = await launcher.getConnection();
    expect(connection?.url).toBe(installed.status.url);
    expect(connection?.token.length).toBeGreaterThan(20);

    const restarted = await launcher.restart();
    expect(restarted.ok, restarted.message ?? undefined).toBe(true);
    expect(restarted.status.running).toBe(true);
    expect(restarted.status.pid).not.toBe(firstPid);
    expect(restarted.message).toContain("old pid");

    const stopped = await launcher.stop();
    expect(stopped.ok, stopped.message ?? undefined).toBe(true);
    expect(stopped.status.running).toBe(false);
    expect(stopped.status.installed).toBe(true);

    const started = await launcher.start();
    expect(started.ok, started.message ?? undefined).toBe(true);
    expect(started.status.running).toBe(true);

    const uninstalled = await launcher.uninstall();
    expect(uninstalled.ok, uninstalled.message ?? undefined).toBe(true);
    expect(uninstalled.status.installed).toBe(false);
    expect(uninstalled.status.running).toBe(false);
    await expect(stat(runtime.loginItemPath)).rejects.toThrow();
    await expect(stat(path.join(config.stageRoot, "installed.json"))).rejects.toThrow();
    expect(runtime.child).toBeNull();
  });
});
