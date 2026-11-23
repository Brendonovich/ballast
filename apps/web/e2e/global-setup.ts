import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

interface CliResult {
  readonly code: number | null;
  readonly output: string;
}

const runCli = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<CliResult> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(repoRoot, "apps/agent/src/bin.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => resolveRun({ code, output }));
  });

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
  let tempRoot: string | undefined;
  let projectPath: string | undefined;
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "ballast-real-e2e-"));
    const stateDir = join(tempRoot, "state");
    const dataDir = join(tempRoot, "data");
    const logPath = join(tempRoot, "service.log");
    projectPath = join(repoRoot, "examples", `.ballast-e2e-${process.pid}-${Date.now()}`);
    await mkdir(join(projectPath, "scripts"), { recursive: true });
    await copyFile(join(repoRoot, "examples/tick-echo.ts"), join(projectPath, "scripts/tick-echo.ts"));
    await copyFile(join(repoRoot, "examples/obs-scene.ts"), join(projectPath, "scripts/obs-scene.ts"));
    await copyFile(join(repoRoot, "examples/package.json"), join(projectPath, "package.json"));

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

    const added = await runCli(["projects", "add", projectPath, "--name", "E2E Real"], {
      BALLAST_SERVICE_URL: url,
      BALLAST_SERVICE_TOKEN: token,
    });
    if (added.code !== 0) throw new Error(`projects add failed: ${added.output}`);
    const addedJson: unknown = JSON.parse(added.output.slice(added.output.indexOf("{")));
    if (typeof addedJson !== "object" || addedJson === null || !("summary" in addedJson)) {
      throw new Error("projects add returned no project");
    }
    const summary = addedJson.summary;
    if (typeof summary !== "object" || summary === null || !("id" in summary) || typeof summary.id !== "string") {
      throw new Error("projects add returned no project id");
    }

    const info: RealServiceInfo = {
      url,
      token,
      pid: service.pid ?? 0,
      projectId: summary.id,
      projectPath,
      tempRoot,
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
    if (service !== undefined) await stopProcess(service);
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
    if (projectPath !== undefined) await rm(projectPath, { recursive: true, force: true });
  }
}
