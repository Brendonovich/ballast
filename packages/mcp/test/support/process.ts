import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const agentBin = join(repoRoot, "apps/agent/src/bin.ts");
export const mcpRoot = join(repoRoot, "packages/mcp");
export const mcpBin = join(mcpRoot, "src/bin.ts");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Registration {
  readonly url: string;
  readonly token: string;
}

export interface RunningService {
  readonly root: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly registration: Registration;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

const readRegistration = async (stateDir: string): Promise<Registration | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(join(stateDir, "service.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    return typeof record["url"] === "string" && typeof record["token"] === "string"
      ? { url: record["url"], token: record["token"] }
      : undefined;
  } catch {
    return undefined;
  }
};

const waitFor = async <A>(
  operation: () => Promise<A | undefined>,
  timeoutMs = 30_000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (cause) {
      last = cause;
    }
    await delay(100);
  }
  throw last instanceof Error ? last : new Error("Timed out waiting for the Ballast service");
};

/**
 * Start the real agent service with throwaway state/data directories. This is
 * the same process the desktop shell supervises, only launched in the
 * foreground for the test.
 */
export const startService = async (): Promise<RunningService> => {
  const root = await mkdtemp(join(tmpdir(), "ballast-mcp-test-"));
  const stateDir = join(root, "state");
  const dataDir = join(root, "data");
  const logs = join(root, "logs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BALLAST_STATE_DIR: stateDir,
    BALLAST_DATA_DIR: dataDir,
    BALLAST_LOG_DIR: logs,
  };
  const child: ChildProcess = spawn(
    process.execPath,
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
      logs,
    ],
    { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > 100_000) output = output.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start the Ballast service");

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

  try {
    const registration = await waitFor(() => readRegistration(stateDir));
    await waitFor(async () => {
      const response = await fetch(registration.url + "/health");
      return response.ok ? true : undefined;
    }, 10_000);
    return {
      root,
      stateDir,
      dataDir,
      registration,
      log: () => output,
      stop,
    };
  } catch (cause) {
    await stop();
    await rm(root, { recursive: true, force: true });
    throw new Error(
      "ballast serve did not start: " +
        (cause instanceof Error ? cause.message : String(cause)) +
        "\n" +
        output.slice(-4_000),
    );
  }
};

export const cleanupService = async (service: RunningService): Promise<void> => {
  await service.stop();
  await rm(service.root, { recursive: true, force: true });
};
