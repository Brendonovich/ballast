import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAgentRuntime } from "../src/agent/client.ts";
import type { AgentRuntime } from "../src/agent/client.ts";
import { realServiceInfoPath, webRoot } from "./real-service.ts";
import type { RealServiceInfo } from "./real-service.ts";

const repoRoot = resolve(webRoot, "../..");
const distDir = join(webRoot, "dist");
const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const waitForFile = async (path: string, timeout = 20_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
};

const waitForHealth = async (url: string, timeout = 20_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(new URL("/health", url));
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for the service /health");
};

interface VtsFixtureProcess {
  readonly pid: number;
  readonly url: string;
}

const startVtsFixture = (): Promise<VtsFixtureProcess> =>
  new Promise((resolveFixture, rejectFixture) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", join(webRoot, "e2e/vts-fixture-server.ts")],
      {
        cwd: webRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectFixture(new Error("Timed out starting the VTube Studio fixture"));
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value === "object" &&
          value !== null &&
          "url" in value &&
          typeof value.url === "string" &&
          child.pid !== undefined
        ) {
          clearTimeout(timer);
          resolveFixture({ pid: child.pid, url: value.url });
          return;
        }
      } catch {
        // Wait for the complete JSON line.
      }
      clearTimeout(timer);
      child.kill("SIGTERM");
      rejectFixture(new Error("VTube Studio fixture printed an unexpected line: " + line));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectFixture(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectFixture(new Error("VTube Studio fixture exited with " + String(code)));
    });
  });

const connectionApprovalKind = async (
  runtime: AgentRuntime,
  connectionId: string,
  kind: "vtuber-studio" | "accessibility",
  timeout = 15_000,
): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const listed = await runtime.run(runtime.client.ListConnections());
    const connection = listed.connections.find((entry) => entry.id === connectionId);
    if (connection?.approval?.kind === kind) return true;
    await sleep(200);
  }
  return false;
};

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < 5_000) await sleep(100);
  if (child.exitCode === null) child.kill("SIGKILL");
};

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(distDir, "index.html"))) {
    console.warn("[real-service e2e] apps/web/dist is missing; skipping the real-service spec.");
    return;
  }

  let service: ChildProcess | undefined;
  let vtsFixture: VtsFixtureProcess | undefined;
  let runtime: AgentRuntime | undefined;
  let tempRoot: string | undefined;
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "ballast-real-e2e-"));
    const stateDir = join(tempRoot, "state");
    const dataDir = join(tempRoot, "data");
    const projectsDir = join(tempRoot, "projects");
    const logPath = join(tempRoot, "service.log");

    vtsFixture = await startVtsFixture();
    const log = openSync(logPath, "w");
    service = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        join(repoRoot, "apps/agent/src/bin.ts"),
        "serve",
        "--port",
        "0",
        "--state-dir",
        stateDir,
        "--data-dir",
        dataDir,
        "--web-dir",
        distDir,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_PROJECTS_DIR: projectsDir,
          BALLAST_TWITCH_CALLBACK_PORT: "43123",
          BALLAST_WEB_DIR: distDir,
        },
        stdio: ["ignore", log, log],
      },
    );

    await waitForFile(join(stateDir, "service.json"));
    const registration: unknown = JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    if (typeof registration !== "object" || registration === null) {
      throw new Error("service.json is not an object");
    }
    const url = "url" in registration && typeof registration.url === "string" ? registration.url : undefined;
    const token = "token" in registration && typeof registration.token === "string" ? registration.token : undefined;
    if (url === undefined || token === undefined) throw new Error("service.json has no url/token");
    await waitForHealth(url);

    if (vtsFixture === undefined) throw new Error("VTube Studio fixture did not start");

    const rpc = new URL("/rpc", url);
    rpc.protocol = rpc.protocol === "https:" ? "wss:" : "ws:";
    rpc.searchParams.set("token", token);
    runtime = await createAgentRuntime({
      kind: "websocket",
      label: "e2e setup",
      rpcUrl: rpc.toString(),
      token,
    });

    let vtuberStudio = false;
    let accessibility = false;
    let vtsConnectionId: string | undefined;
    let keyboardConnectionId: string | undefined;
    try {
      const vts = await runtime.run(
        runtime.client.CreateConnection({
          integration: "vts",
          label: "VTube Studio",
          config: { url: vtsFixture.url, pluginName: "Ballast" },
        }),
      );
      vtsConnectionId = vts.id;
      await runtime.run(runtime.client.ConnectConnection({ connectionId: vts.id }));
      vtuberStudio = await connectionApprovalKind(runtime, vts.id, "vtuber-studio");
    } catch (error) {
      console.warn(
        "[real-service e2e] VTube Studio connection fixture failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      const keyboard = await runtime.run(
        runtime.client.CreateConnection({
          integration: "keyboard",
          label: "Keyboard",
          config: { permission: "denied" },
        }),
      );
      keyboardConnectionId = keyboard.id;
      await runtime.run(runtime.client.ConnectConnection({ connectionId: keyboard.id }));
      accessibility = await connectionApprovalKind(runtime, keyboard.id, "accessibility");
    } catch (error) {
      console.warn(
        "[real-service e2e] keyboard connection fixture failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    await runtime.dispose();
    runtime = undefined;
    if (!vtuberStudio) {
      console.warn("[real-service e2e] VTube Studio approval fixture was not observed.");
    }
    if (!accessibility) {
      console.warn("[real-service e2e] keyboard accessibility approval was not observed.");
    }

    const info: RealServiceInfo = {
      url,
      token,
      pid: service.pid ?? 0,
      projectsDir,
      tempRoot,
      vtsPid: vtsFixture.pid,
      approvals: { vtuberStudio, accessibility },
      connections: { vts: vtsConnectionId, keyboard: keyboardConnectionId },
    };
    await mkdir(join(webRoot, "test-results"), { recursive: true });
    await writeFile(realServiceInfoPath, JSON.stringify(info));
    console.log(`[real-service e2e] service ready at ${url}`);
  } catch (error) {
    console.warn(
      "[real-service e2e] could not start the real service; the real-service spec will be skipped:",
      error instanceof Error ? error.message : String(error),
    );
    if (tempRoot !== undefined) console.warn(`[real-service e2e] service log: ${join(tempRoot, "service.log")}`);
    if (runtime !== undefined) await runtime.dispose();
    if (service !== undefined) await stopProcess(service);
    if (vtsFixture !== undefined) {
      try {
        process.kill(vtsFixture.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  }
}
