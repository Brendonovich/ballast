import { execFile } from "node:child_process";
import { readFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(desktopRoot, "..", "..");
const agentRoot = path.join(repoRoot, "apps", "agent");
const electronPath = createRequire(import.meta.url)("electron") as string;
const cliPath = path.join(agentRoot, "src", "bin.ts");

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DemoStatus {
  readonly phase: string;
  readonly running: boolean;
  readonly pid: number | null;
  readonly permissions?: { readonly accessibility?: string };
}

interface DemoPayload {
  readonly ok: boolean;
  readonly message?: string;
  readonly status: DemoStatus;
}

interface ConsentList {
  readonly consents: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
  }>;
}

interface HealthPayload {
  readonly ok: boolean;
  readonly pid?: number;
  readonly permissions?: { readonly accessibility?: string };
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeout?: number },
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

const parseDemo = (stdout: string): DemoPayload => {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("BALLAST_DEMO "));
  if (line === undefined) throw new Error("no BALLAST_DEMO line in:\n" + stdout);
  return JSON.parse(line.slice("BALLAST_DEMO ".length)) as DemoPayload;
};

const parseCliJson = <A>(stdout: string): A => {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("no JSON in CLI output:\n" + stdout);
  return JSON.parse(stdout.slice(start)) as A;
};

const runDemo = async (
  action: "start" | "stop" | "status",
  env: NodeJS.ProcessEnv,
): Promise<DemoPayload> => {
  const result = await run(electronPath, [".", "--ballast-demo=" + action], {
    cwd: desktopRoot,
    env,
  });
  if (result.code !== 0) {
    throw new Error(
      "electron --ballast-demo=" + action + " exited " + result.code + "\n" + result.stdout + result.stderr,
    );
  }
  return parseDemo(result.stdout);
};

const runCli = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> =>
  run(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", cliPath, ...args],
    { cwd: repoRoot, env },
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async <A>(
  label: string,
  read: () => Promise<A | undefined>,
  timeoutMs = 30_000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(200);
  }
  throw new Error("timed out waiting for " + label);
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readHealth = async (url: string): Promise<HealthPayload | undefined> => {
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2_000) });
    return response.ok ? ((await response.json()) as HealthPayload) : undefined;
  } catch {
    return undefined;
  }
};

const tickScript = `import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export const title = "E2E Tick";

export default Effect.gen(function* () {
  const prefix = yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
  const fake = yield* Fake.Connection("main");
  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const { text } = yield* fake.echo({ text: \`\${yield* prefix} tick \${tick.n}\` });
      yield* Effect.log(text);
    }),
  );
});
`;

test("real service + Electron UI survives quitting the window", async ({}, testInfo) => {
  test.setTimeout(240_000);

  const root = await mkdtemp(path.join(tmpdir(), "ballast-desktop-e2e-"));
  const appId = "dev.ballast.agent.test";

  const stateDir = path.join(root, "state");
  const dataDir = path.join(root, "data");
  const logDir = path.join(root, "logs");
  const userDataDir = path.join(root, "userData");
  const serviceLog = path.join(logDir, "service.log");
  const project = path.join(root, "project");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BALLAST_APP_ID: appId,
    BALLAST_USER_DATA_DIR: userDataDir,
    BALLAST_STATE_DIR: stateDir,
    BALLAST_DATA_DIR: dataDir,
    BALLAST_LOG_DIR: logDir,
    BALLAST_SERVICE_BUILD_DIR: path.join(agentRoot, "dist-service"),
    BALLAST_START_TIMEOUT_MS: "30000",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BALLAST_UI_URL;
  delete env.BALLAST_SERVICE_VERSION;
  delete env.BALLAST_AUTOSTART;

  let ui: ElectronApplication | undefined;
  let page: Page | undefined;
  let servicePid: number | undefined;

  const cleanup = async (): Promise<void> => {
    await ui?.close().catch(() => undefined);
    if (servicePid !== undefined && alive(servicePid)) {
      try {
        process.kill(servicePid, "SIGTERM");
      } catch {
        // already gone
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && alive(servicePid)) await sleep(100);
      if (alive(servicePid)) {
        try {
          process.kill(servicePid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  };

  try {
    await mkdir(project, { recursive: true });
    await mkdir(path.join(project, "node_modules", "@ballast"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    for (const pkg of ["core", "fake"]) {
      await symlink(
        path.join(agentRoot, "node_modules", "@ballast", pkg),
        path.join(project, "node_modules", "@ballast", pkg),
        "dir",
      );
    }
    await symlink(
      path.join(agentRoot, "node_modules", "effect"),
      path.join(project, "node_modules", "effect"),
      "dir",
    );
    await writeFile(path.join(project, "ballast.ts"), tickScript, "utf8");
    await stat(path.join(agentRoot, "dist-service", "main.mjs"));

    // 1. Start the real service as a detached background process via the
    // same launcher the tray and IPC use; the demo process exits right away.
    const service = await runDemo("start", env);
    expect(service.ok, service.message).toBe(true);
    expect(service.status).toMatchObject({ phase: "running", running: true });
    if (service.status.pid === null) throw new Error("started service has no pid");
    servicePid = service.status.pid;
    expect(servicePid).toBeGreaterThan(0);
    expect(alive(servicePid)).toBe(true);

    // 2. Add a project, start its script, approve consent and prove it runs.
    const added = await runCli(["projects", "add", project, "--name", "E2E Tick"], env);
    expect(added.code, added.stderr).toBe(0);
    const projectId = parseCliJson<{ readonly summary: { readonly id: string } }>(
      added.stdout,
    ).summary.id;
    expect(projectId.length).toBeGreaterThan(0);

    const configured = await runCli(["connections", "configure", "fake/main"], env);
    expect(configured.code, configured.stderr).toBe(0);

    const started = await runCli(["projects", "start", projectId], env);
    expect(started.code, started.stderr).toBe(0);
    const consent = await waitFor("consent request", async () => {
      const listed = await runCli(["projects", "consents"], env);
      if (listed.code !== 0) return undefined;
      return parseCliJson<ConsentList>(listed.stdout).consents.find(
        (candidate) => candidate.projectId === projectId,
      );
    });
    const approved = await runCli(["projects", "approve", consent.id], env);
    expect(approved.code, approved.stderr).toBe(0);
    const running = await runCli(["projects", "start", projectId], env);
    expect(running.code, running.stderr).toBe(0);
    expect(
      parseCliJson<{ readonly summary: { readonly status: string } }>(running.stdout).summary.status,
    ).toBe("running");

    await waitFor(
      "worker tick in service.log",
      async () => {
        const content = await readFile(serviceLog, "utf8").catch(() => "");
        return /tick \d+/.test(content) ? content : undefined;
      },
      30_000,
    );

    // 3. Load the real service UI in Electron (Playwright drives the same
    // window through CDP) and open the script detail.
    ui = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      cwd: desktopRoot,
      env,
      timeout: 60_000,
    });
    page = await ui.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    expect(await page.evaluate(() => globalThis.location.href)).not.toContain("token=");

    const bridgeStatus = await page.evaluate(async () => {
      interface BridgeLike {
        readonly service: { status(): Promise<DemoStatus> };
        readonly permissions: {
          status(): Promise<{ readonly accessibility: string }>;
        };
      }
      const isBridge = (value: unknown): value is BridgeLike => {
        if (typeof value !== "object" || value === null) return false;
        const service = Reflect.get(value, "service");
        const permissions = Reflect.get(value, "permissions");
        return (
          typeof service === "object" &&
          service !== null &&
          typeof Reflect.get(service, "status") === "function" &&
          typeof permissions === "object" &&
          permissions !== null &&
          typeof Reflect.get(permissions, "status") === "function"
        );
      };
      const candidate: unknown = Reflect.get(globalThis, "ballast");
      if (!isBridge(candidate)) return { hasBridge: false as const };
      return {
        hasBridge: true as const,
        status: await candidate.service.status(),
        permissions: await candidate.permissions.status(),
      };
    });
    expect(bridgeStatus.hasBridge).toBe(true);
    if (!bridgeStatus.hasBridge) throw new Error("window.ballast is missing in the service UI");
    expect(bridgeStatus.status.running).toBe(true);
    expect(bridgeStatus.status.pid).toBe(servicePid);
    expect(["granted", "denied", "unknown"]).toContain(bridgeStatus.permissions.accessibility);
    expect(bridgeStatus.status.permissions?.accessibility).toBe(
      bridgeStatus.permissions.accessibility,
    );

    const registration = JSON.parse(
      await readFile(path.join(stateDir, "service.json"), "utf8"),
    ) as { readonly url: string };
    const health = await waitFor("shell permission reported to /health", async () => {
      const value = await readHealth(registration.url);
      return value?.permissions?.accessibility === bridgeStatus.permissions.accessibility
        ? value
        : undefined;
    });
    expect(health.ok).toBe(true);

    await page.evaluate(
      (hash) => {
        globalThis.location.hash = hash;
      },
      "#/projects/" + encodeURIComponent(projectId),
    );
    await expect(page.locator("body")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ballast-e2e-ui.png"), fullPage: true });

    const beforeQuit = await readFile(serviceLog, "utf8").catch(() => "");
    const ticksBeforeQuit = (beforeQuit.match(/tick \d+/g) ?? []).length;

    // 4. Quit the UI; the detached service and worker must keep going.
    await ui.close();
    ui = undefined;
    await sleep(1_500);
    expect(alive(servicePid)).toBe(true);
    const afterQuitHealth = await waitFor("service health after UI quit", () =>
      readHealth(registration.url),
    );
    expect(afterQuitHealth.ok).toBe(true);
    expect(afterQuitHealth.pid).toBe(servicePid);
    const afterQuit = await waitFor("ticks after UI quit", async () => {
      const content = await readFile(serviceLog, "utf8").catch(() => "");
      return (content.match(/tick \d+/g) ?? []).length > ticksBeforeQuit ? content : undefined;
    });
    expect(afterQuit.length).toBeGreaterThan(beforeQuit.length);

    // 5. Stop through the launcher and prove nothing is left.
    const stopped = await runDemo("stop", env);
    expect(stopped.ok, stopped.message).toBe(true);
    expect(stopped.status).toMatchObject({ phase: "stopped", running: false });
    expect(alive(servicePid)).toBe(false);
    await expect(stat(path.join(stateDir, "service.json"))).rejects.toThrow();
  } finally {
    await cleanup();
  }
});

test("shows the bundled fallback page while the service is not running", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), "ballast-desktop-fallback-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BALLAST_APP_ID: "dev.ballast.agent.e2e-fallback." + process.pid,
    BALLAST_USER_DATA_DIR: path.join(root, "userData"),
    BALLAST_STATE_DIR: path.join(root, "state"),
    BALLAST_DATA_DIR: path.join(root, "data"),
    BALLAST_LOG_DIR: path.join(root, "logs"),
    BALLAST_SERVICE_BUILD_DIR: path.join(agentRoot, "dist-service"),
    BALLAST_AUTOSTART: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BALLAST_UI_URL;
  delete env.BALLAST_SERVICE_VERSION;

  const ui = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: desktopRoot,
    env,
    timeout: 60_000,
  });
  try {
    const page = await ui.firstWindow();
    await expect(page.getByRole("heading", { name: /Starting Ballast/ })).toBeVisible();
    await expect(page.locator("#phase")).toHaveText("stopped");
    expect(await page.evaluate(() => globalThis.location.protocol)).toBe("file:");
    const hasBridge = await page.evaluate(() => {
      const candidate: unknown = Reflect.get(globalThis, "ballast");
      return typeof candidate === "object" && candidate !== null && "service" in candidate;
    });
    expect(hasBridge).toBe(true);
  } finally {
    await ui.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
