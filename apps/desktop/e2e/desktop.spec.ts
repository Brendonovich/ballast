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

const bridgeOpenProject = async (
  page: Page,
  projectId: string,
  newWindow: boolean,
): Promise<void> => {
  await page.evaluate(
    async ({ id, separate }) => {
      const bridge: unknown = Reflect.get(globalThis, "ballast");
      if (typeof bridge !== "object" || bridge === null) {
        throw new Error("window.ballast is missing");
      }
      const windows: unknown = Reflect.get(bridge, "windows");
      if (typeof windows !== "object" || windows === null) {
        throw new Error("window.ballast.windows is missing");
      }
      const open = Reflect.get(windows, "openProjectWindow");
      if (typeof open !== "function") {
        throw new Error("openProjectWindow is missing");
      }
      await open.call(windows, id, { newWindow: separate });
    },
    { id: projectId, separate: newWindow },
  );
};

const projectPage = async (
  ui: ElectronApplication,
  projectId: string,
): Promise<Page> =>
  waitFor("project window " + projectId, async () => {
    const encoded = encodeURIComponent(projectId);
    return ui
      .windows()
      .find(
        (candidate) =>
          candidate.url().includes("/projects/" + encoded) &&
          !candidate.url().includes("/artifacts/"),
      );
  });

const bridgeOpenArtifact = async (
  page: Page,
  projectId: string,
  artifact: string,
): Promise<void> => {
  await page.evaluate(
    async ({ id, name }) => {
      const bridge: unknown = Reflect.get(globalThis, "ballast");
      if (typeof bridge !== "object" || bridge === null) {
        throw new Error("window.ballast is missing");
      }
      const windows: unknown = Reflect.get(bridge, "windows");
      if (typeof windows !== "object" || windows === null) {
        throw new Error("window.ballast.windows is missing");
      }
      const open = Reflect.get(windows, "openArtifactWindow");
      if (typeof open !== "function") {
        throw new Error("openArtifactWindow is missing");
      }
      await open.call(windows, id, name);
    },
    { id: projectId, name: artifact },
  );
};

const artifactPage = async (
  ui: ElectronApplication,
  projectId: string,
  artifact: string,
): Promise<Page> =>
  waitFor("artifact window " + artifact, async () => {
    const encodedProject = encodeURIComponent(projectId);
    const encodedArtifact = encodeURIComponent(artifact);
    return ui
      .windows()
      .find((candidate) =>
        candidate
          .url()
          .includes("/projects/" + encodedProject + "/artifacts/" + encodedArtifact),
      );
  });

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
  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    entry: "./artifacts/dashboard/main.ts",
  });
  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const { text } = yield* fake.echo({ text: \`\${yield* prefix} tick \${tick.n}\` });
      yield* Effect.log(text);
    }),
  );
}) satisfies Ballast.Project;
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
  const secondProject = path.join(root, "project-two");

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
    await mkdir(stateDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    for (const [directory, script] of [
      [project, tickScript],
      [secondProject, tickScript.replace("E2E Tick", "E2E Second")],
    ] as const) {
      await mkdir(path.join(directory, "node_modules", "@ballast"), { recursive: true });
      for (const pkg of ["core", "fake"]) {
        await symlink(
          path.join(agentRoot, "node_modules", "@ballast", pkg),
          path.join(directory, "node_modules", "@ballast", pkg),
          "dir",
        );
      }
      await symlink(
        path.join(agentRoot, "node_modules", "effect"),
        path.join(directory, "node_modules", "effect"),
        "dir",
      );
      await mkdir(path.join(directory, "artifacts", "dashboard"), { recursive: true });
      await writeFile(
        path.join(directory, "artifacts", "dashboard", "main.ts"),
        'export default (root: HTMLElement) => {\n  root.textContent = "E2E artifact";\n};\n',
        "utf8",
      );
      await writeFile(path.join(directory, "ballast.ts"), script, "utf8");
    }
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

    const addedSecond = await runCli(
      ["projects", "add", secondProject, "--name", "E2E Second"],
      env,
    );
    expect(addedSecond.code, addedSecond.stderr).toBe(0);
    const secondProjectId = parseCliJson<{ readonly summary: { readonly id: string } }>(
      addedSecond.stdout,
    ).summary.id;
    expect(secondProjectId.length).toBeGreaterThan(0);

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

    await expect(page).toHaveTitle("Ballast");
    const homeRow = page.getByTestId("project-row").filter({ hasText: "E2E Tick" });
    await expect(homeRow).toBeVisible({ timeout: 30_000 });
    await homeRow.getByTestId("project-open").click();
    await page.waitForURL(
      new RegExp("#/projects/" + encodeURIComponent(projectId) + "$"),
      { timeout: 30_000 },
    );
    await expect.poll(() => page.title()).toBe("E2E Tick — Ballast");
    await expect(page.getByTestId("project-nav-projects")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ballast-window-1.png"), fullPage: true });

    await bridgeOpenProject(page, secondProjectId, true);
    const secondPage = await projectPage(ui, secondProjectId);
    await expect.poll(() => secondPage.title()).toBe("E2E Second — Ballast");
    await expect.poll(() => ui.windows().length).toBe(2);

    // Opening an already-open project focuses its window instead of duplicating it.
    await bridgeOpenProject(secondPage, secondProjectId, true);
    const focusedSecond = await ui.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? "",
    );
    expect(focusedSecond).toContain(encodeURIComponent(secondProjectId));
    await bridgeOpenProject(secondPage, projectId, true);
    const focusedFirst = await ui.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? "",
    );
    expect(focusedFirst).toContain(encodeURIComponent(projectId));
    await expect.poll(() => ui.windows().length).toBe(2);
    await secondPage.screenshot({
      path: testInfo.outputPath("ballast-window-2.png"),
      fullPage: true,
    });

    // Pop an artifact into its own window; reopening focuses it.
    await bridgeOpenArtifact(page, projectId, "dashboard");
    const artifactWindow = await artifactPage(ui, projectId, "dashboard");
    await expect.poll(() => artifactWindow.title()).toBe(
      "Stream dashboard — E2E Tick — Ballast",
    );
    await expect.poll(() => ui.windows().length).toBe(3);
    await expect(
      artifactWindow.frameLocator("iframe").getByText("E2E artifact"),
    ).toBeVisible({ timeout: 20_000 });
    await bridgeOpenArtifact(page, projectId, "dashboard");
    const focusedArtifact = await ui.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? "",
    );
    expect(focusedArtifact).toContain("/artifacts/dashboard");
    await expect.poll(() => ui.windows().length).toBe(3);

    const firstBounds = { x: 20, y: 40, width: 900, height: 620 };
    const secondBounds = { x: 700, y: 40, width: 900, height: 620 };
    await ui.evaluate(
      ({ BrowserWindow }, bounds) => {
        for (const window of BrowserWindow.getAllWindows()) {
          const url = window.webContents.getURL();
          if (url.includes("/projects/" + encodeURIComponent(bounds.firstId))) {
            window.setBounds(bounds.first);
          }
          if (url.includes("/projects/" + encodeURIComponent(bounds.secondId))) {
            window.setBounds(bounds.second);
          }
        }
      },
      {
        firstId: projectId,
        secondId: secondProjectId,
        first: firstBounds,
        second: secondBounds,
      },
    );
    await sleep(500);

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

    // 5. Relaunch restores both project windows, the artifact window and bounds.
    ui = await electron.launch({
      executablePath: electronPath,
      args: ["."],
      cwd: desktopRoot,
      env,
      timeout: 60_000,
    });
    await waitFor("restored windows", async () =>
      ui !== undefined && ui.windows().length >= 3 ? true : undefined,
    );
    const restoredFirst = await projectPage(ui, projectId);
    const restoredSecond = await projectPage(ui, secondProjectId);
    const restoredArtifact = await artifactPage(ui, projectId, "dashboard");
    await expect.poll(() => restoredFirst.title()).toBe("E2E Tick — Ballast");
    await expect.poll(() => restoredSecond.title()).toBe("E2E Second — Ballast");
    await expect.poll(() => restoredArtifact.title()).toBe(
      "Stream dashboard — E2E Tick — Ballast",
    );
    const restoredBounds = await ui.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        url: window.webContents.getURL(),
        bounds: window.getBounds(),
      })),
    );
    const firstRestored = restoredBounds.find(
      (entry) =>
        entry.url.includes("/projects/" + encodeURIComponent(projectId)) &&
        !entry.url.includes("/artifacts/"),
    );
    const secondRestored = restoredBounds.find(
      (entry) =>
        entry.url.includes("/projects/" + encodeURIComponent(secondProjectId)) &&
        !entry.url.includes("/artifacts/"),
    );
    expect(firstRestored?.bounds).toEqual(firstBounds);
    expect(secondRestored?.bounds).toEqual(secondBounds);

    await ui.close();
    ui = undefined;
    const afterQuit = await waitFor("ticks after UI quit", async () => {
      const content = await readFile(serviceLog, "utf8").catch(() => "");
      return (content.match(/tick \d+/g) ?? []).length > ticksBeforeQuit ? content : undefined;
    });
    expect(afterQuit.length).toBeGreaterThan(beforeQuit.length);

    // 6. Stop through the launcher and prove nothing is left.
    const stopped = await runDemo("stop", env);
    expect(stopped.ok, stopped.message).toBe(true);
    expect(stopped.status).toMatchObject({ phase: "stopped", running: false });
    expect(alive(servicePid)).toBe(false);
    await expect(stat(path.join(stateDir, "service.json"))).rejects.toThrow();
  } finally {
    await cleanup();
  }
});

test("recovers from the bundled fallback once the service starts", async () => {
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
  let servicePid: number | undefined;
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

    const started = await runDemo("start", env);
    expect(started.ok, started.message).toBe(true);
    servicePid = started.status.pid ?? undefined;
    if (servicePid === undefined) throw new Error("started service has no pid");

    // No Retry click: the shell polls and navigates on its own.
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    expect(new URL(page.url()).protocol).toBe("http:");
  } finally {
    await ui.close().catch(() => undefined);
    if (servicePid !== undefined && alive(servicePid)) {
      await runDemo("stop", env).catch(() => undefined);
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
  }
});
test("waits for the initial service before loading the window", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(tmpdir(), "ballast-desktop-first-window-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BALLAST_APP_ID: "dev.ballast.agent.e2e-first." + process.pid,
    BALLAST_USER_DATA_DIR: path.join(root, "userData"),
    BALLAST_STATE_DIR: path.join(root, "state"),
    BALLAST_DATA_DIR: path.join(root, "data"),
    BALLAST_LOG_DIR: path.join(root, "logs"),
    BALLAST_SERVICE_BUILD_DIR: path.join(agentRoot, "dist-service"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BALLAST_UI_URL;
  delete env.BALLAST_SERVICE_VERSION;
  delete env.BALLAST_AUTOSTART;

  let servicePid: number | undefined;
  const ui = await electron.launch({
    executablePath: electronPath,
    args: ["."],
    cwd: desktopRoot,
    env,
    timeout: 60_000,
  });
  try {
    const page = await ui.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    await page.waitForLoadState("domcontentloaded");
    expect(new URL(page.url()).protocol).toBe("http:");
    const status = await runDemo("status", env);
    servicePid = status.status.pid ?? undefined;
    expect(status.status.running).toBe(true);
  } finally {
    await ui.close().catch(() => undefined);
    if (servicePid === undefined) {
      const status = await runDemo("status", env).catch(() => undefined);
      servicePid = status?.status.pid ?? undefined;
    }
    if (servicePid !== undefined && alive(servicePid)) {
      await runDemo("stop", env).catch(() => undefined);
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
  }
});
