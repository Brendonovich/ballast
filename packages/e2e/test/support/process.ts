import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const cloudDir = join(repoRoot, "apps/cloud");
export const agentBin = join(repoRoot, "apps/agent/src/bin.ts");

export interface RunningProcess {
  readonly pid: number;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async <A>(
  operation: () => Promise<A | undefined>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<A> => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (cause) {
      lastError = cause;
    }
    await delay(intervalMs);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for condition");
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const spawnLogged = (
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): RunningProcess => {
  const child: ChildProcess = spawn(process.execPath, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  const append = (chunk: Buffer) => {
    log += chunk.toString();
    if (log.length > 200_000) log = log.slice(-200_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start process");
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await Promise.race([exited, delay(2_000)]);
    }
  };
  return { pid, log: () => log, stop };
};

const nodeSupported = (): boolean => {
  const [major, minor] = process.versions.node.split(".").map((value) => Number(value));
  return (
    (major === 22 && (minor ?? 0) >= 22) ||
    (major === 24 && (minor ?? 0) >= 11) ||
    (major !== undefined && major > 24)
  );
};

export interface CloudProcess {
  readonly url: string;
  readonly stage: string;
  readonly process: RunningProcess;
  readonly home: string;
}

export const startCloud = async (options: {
  readonly twitchBaseUrl: string;
}): Promise<CloudProcess> => {
  if (!nodeSupported()) {
    throw new Error(
      "alchemy dev needs Node >=24.11.1 or >=22.22.3; run the e2e command under fnm 24.22.2",
    );
  }
  const home = await mkdtemp(join(tmpdir(), "ballast-e2e-cloud-home-"));
  const port = await freePort();
  const stage = "e2e_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  const url = "http://127.0.0.1:" + port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    BALLAST_DEV_PORT: String(port),
    TWITCH_CLIENT_ID: "e2e-client",
    TWITCH_CLIENT_SECRET: "e2e-secret",
    BALLAST_TOKEN_KEY: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
    BALLAST_TOKEN_PEPPER: "e2e-pepper",
    TWITCH_ID_BASE_URL: options.twitchBaseUrl,
    TWITCH_API_BASE_URL: options.twitchBaseUrl,
  };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const child = spawnLogged(
    [
      "--experimental-transform-types",
      "--no-warnings=ExperimentalWarning",
      "--env-file-if-exists=.dev.vars",
      "--env-file-if-exists=.env",
      join(cloudDir, "node_modules/alchemy/bin/alchemy.js"),
      "dev",
      "--stage",
      stage,
    ],
    { cwd: cloudDir, env },
  );
  try {
    await waitFor(
      async () => {
        const response = await fetch(url + "/health");
        return response.ok ? true : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 500 },
    );
  } catch (cause) {
    await child.stop();
    throw new Error(
      "alchemy dev did not start: " +
        (cause instanceof Error ? cause.message : String(cause)) +
        "\n" +
        child.log().slice(-4_000),
    );
  }
  return { url, stage, process: child, home };
};

export interface ServiceRegistration {
  readonly url: string;
  readonly token: string;
}

const readRegistration = async (stateDir: string): Promise<ServiceRegistration | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return typeof record["url"] === "string" && typeof record["token"] === "string"
      ? { url: record["url"], token: record["token"] }
      : undefined;
  } catch {
    return undefined;
  }
};

export interface ServiceProcess {
  readonly stateDir: string;
  readonly dataDir: string;
  readonly registration: ServiceRegistration;
  readonly process: RunningProcess;
}

export const startService = async (options: {
  readonly root: string;
  readonly cloudUrl: string;
  readonly stateDir?: string;
  readonly dataDir?: string;
  readonly home?: string;
}): Promise<ServiceProcess> => {
  const stateDir = options.stateDir ?? join(options.root, "state");
  const dataDir = options.dataDir ?? join(options.root, "data");
  const home = options.home ?? join(options.root, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    BALLAST_STATE_DIR: stateDir,
    BALLAST_DATA_DIR: dataDir,
    BALLAST_LOG_DIR: join(options.root, "logs"),
    BALLAST_ARTIFACT_PORT: "0",
  };
  const child = spawnLogged(
    [
      "--experimental-strip-types",
      "--no-warnings=ExperimentalWarning",
      agentBin,
      "serve",
      "--port",
      "0",
      "--state-dir",
      stateDir,
      "--data-dir",
      dataDir,
      "--log-dir",
      join(options.root, "logs"),
      "--cloud",
      options.cloudUrl,
    ],
    { cwd: repoRoot, env },
  );
  try {
    const registration = await waitFor(
      () => readRegistration(stateDir),
      { timeoutMs: 30_000, intervalMs: 100 },
    );
    await waitFor(
      async () => {
        const response = await fetch(registration.url + "/health");
        return response.ok ? true : undefined;
      },
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    return { stateDir, dataDir, registration, process: child };
  } catch (cause) {
    await child.stop();
    throw new Error(
      "ballast serve did not start: " +
        (cause instanceof Error ? cause.message : String(cause)) +
        "\n" +
        child.log().slice(-4_000),
    );
  }
};
