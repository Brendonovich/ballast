import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface BridgeOptions {
  /** "inset" mimics the macOS app, whose top bar is the title bar. */
  readonly titleBar?: "inset" | "native";
  /** Projects another window already shows; re-scoping to them focuses it. */
  readonly openElsewhere?: ReadonlyArray<string>;
}

/** Calls the fake bridge received, recorded in order. */
const bridgeCalls = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => {
    const raw = sessionStorage.getItem("ballast.bridge.calls");
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  });

const installBridge = async (page: Page, options: BridgeOptions = {}): Promise<void> => {
  await page.addInitScript((settings: BridgeOptions) => {
    const record = (call: string): void => {
      const raw = sessionStorage.getItem("ballast.bridge.calls");
      const calls: unknown = raw === null ? [] : JSON.parse(raw);
      sessionStorage.setItem(
        "ballast.bridge.calls",
        JSON.stringify([...(Array.isArray(calls) ? calls : []), call]),
      );
    };
    const status = {
      schemaVersion: 1,
      phase: "running",
      running: true,
      builtVersion: "9.9.9",
      runningVersion: "9.9.9",
      apiVersion: 1,
      pid: 4242,
      url: location.origin,
      startedAt: Date.now(),
      pendingConsents: 0,
      updateAvailable: false,
      lastError: null,
      paths: {
        userDataDir: "/tmp/ballast",
        stageRoot: "/tmp/ballast/service/9.9.9",
        stateDir: "/tmp/ballast/state",
        dataDir: "/tmp/ballast/data",
        logDir: "/tmp/ballast/logs",
      },
    };
    const action = async (name: string) => {
      localStorage.setItem("ballast.bridge.action", name);
      return { ok: true, status, message: null };
    };
    Reflect.set(window, "ballast", {
      version: 4,
      titleBar: settings.titleBar ?? "native",
      service: {
        status: async () => status,
        start: () => action("start"),
        stop: () => action("stop"),
        restart: () => action("restart"),
      },
      permissions: {
        status: async () => ({ accessibility: "denied" }),
        requestAccessibility: async () => {
          localStorage.setItem("ballast.bridge.action", "accessibility");
          return { accessibility: "granted" };
        },
      },
      update: {
        status: async () => ({ phase: "idle", version: null, message: null }),
        install: async () => ({
          ok: true,
          state: { phase: "idle", version: null, message: null },
          message: null,
        }),
      },
      windows: {
        context: async () => ({ kind: "home", route: "projects" }),
        openProjectWindow: async (id: string, open?: { readonly newWindow?: boolean }) => {
          record(`open:${id}:${open?.newWindow === true ? "new" : "reuse"}`);
        },
        rescopeProject: async (id: string) => {
          const focused = (settings.openElsewhere ?? []).includes(id);
          record(`rescope:${id}:${focused ? "focused" : "rescoped"}`);
          return { outcome: focused ? "focused" : "rescoped" };
        },
        openArtifactWindow: async () => {},
        openHome: async (route?: string) => {
          record(`home:${route ?? "projects"}`);
          localStorage.setItem("ballast.bridge.openHome", route ?? "projects");
        },
      },
      projects: {
        setMenu: async () => {},
      },
      app: {
        info: async () => ({
          name: "Ballast",
          version: "9.9.9",
          platform: "darwin",
          arch: "arm64",
          packaged: true,
        }),
        openUi: async () => {},
        retry: async () => {},
        showLogs: async () => {},
        openExternal: async () => {},
        pickDirectory: async () => "/tmp/picked-project",
      },
      events: {
        onServiceStatus: (listener: (status: unknown) => void) => {
          Reflect.set(window, "ballastStatusListener", listener);
          return () => {};
        },
        onUpdateStatus: () => () => {},
      },
    });
  }, options);
};

test("desktop bridge supplies running state and service actions", async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("nav-settings").click();

  await expect(page.getByText("running", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("9.9.9").first()).toBeVisible();

  await page.evaluate(() => {
    const listener = Reflect.get(window, "ballastStatusListener");
    if (typeof listener === "function") {
      listener({
        schemaVersion: 1,
        phase: "stopping",
        running: false,
        builtVersion: "9.9.9",
        runningVersion: "9.9.9",
        apiVersion: 1,
        pid: 4242,
        url: location.origin,
        startedAt: Date.now(),
        pendingConsents: 0,
        updateAvailable: false,
        lastError: null,
        paths: {
          userDataDir: "/tmp/ballast",
          stageRoot: "/tmp/ballast/service/9.9.9",
          stateDir: "/tmp/ballast/state",
          dataDir: "/tmp/ballast/data",
          logDir: "/tmp/ballast/logs",
        },
      });
    }
  });
  await expect(page.getByText("stopping")).toBeVisible();

  await page.getByTestId("service-restart").click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ballast.bridge.action")))
    .toBe("restart");

  await page.getByTestId("service-stop").click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ballast.bridge.action")))
    .toBe("stop");

  // The desktop bridge supplies the native folder picker for a new project.
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("new-project").click();
  await page.getByTestId("create-project-directory-pick").click();
  await expect(page.getByTestId("create-project-directory")).toHaveValue("/tmp/picked-project");
});

test("a desktop project window switches to Connections and Settings in place", async ({ page }) => {
  await installBridge(page);
  await page.goto("/#/projects/proj_main");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  const before = page.context().pages().length;

  await page.getByTestId("project-nav-connections").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main\/connections$/);
  await expect(page.getByTestId("top-bar")).toBeVisible();
  await expect(page.getByTestId("project-nav-connections")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
  await expect(page).toHaveTitle("Connections — Main Channel — Ballast");

  await page.getByTestId("project-back").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main$/);
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  // The switcher's current row also leads back to the project view.
  await page.getByTestId("project-nav-settings").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main\/settings$/);
  await page.getByTestId("project-switcher").click();
  await page.locator('[data-testid="project-switcher-row"][data-current="true"] button').first().click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  expect(page.context().pages().length).toBe(before);
  expect(await bridgeCalls(page)).toEqual([]);
});

test("switching project re-scopes the desktop window through the bridge", async ({ page }) => {
  await installBridge(page);
  await page.goto("/#/projects/proj_main");
  await expect(page.getByTestId("project-switcher")).toContainText("Main Channel");

  await page.getByTestId("project-switcher").click();
  await page
    .locator('[data-testid="project-switcher-row"][data-project-id="proj_alt"] button')
    .first()
    .click();
  await expect(page).toHaveURL(/#\/projects\/proj_alt$/);
  await expect(page).toHaveTitle("Second Channel — Ballast");
  await expect(page.getByTestId("project-switcher")).toContainText("Second Channel");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  expect(await bridgeCalls(page)).toEqual(["rescope:proj_alt:rescoped"]);
});

test("switching to a project open in another window focuses it instead", async ({ page }) => {
  await installBridge(page, { openElsewhere: ["proj_alt"] });
  await page.goto("/#/projects/proj_main");
  await page.getByTestId("project-switcher").click();
  await page
    .locator('[data-testid="project-switcher-row"][data-project-id="proj_alt"] button')
    .first()
    .click();
  await expect.poll(() => bridgeCalls(page)).toEqual(["rescope:proj_alt:focused"]);
  // This window keeps its project.
  await expect(page).toHaveURL(/#\/projects\/proj_main$/);
  await expect(page.getByTestId("project-switcher")).toContainText("Main Channel");
  await expect(page.getByTestId("project-switcher-menu")).toHaveCount(0);
});

test("the switcher opens a project in a new desktop window on request", async ({ page }) => {
  await installBridge(page);
  await page.goto("/#/projects/proj_main");
  await page.getByTestId("project-switcher").click();
  const alt = page.locator('[data-testid="project-switcher-row"][data-project-id="proj_alt"]');
  // The current project has no new-window button; others do.
  await expect(
    page.locator('[data-testid="project-switcher-row"][data-current="true"] [data-testid="project-switcher-new-window"]'),
  ).toHaveCount(0);
  await alt.getByTestId("project-switcher-new-window").click();
  await expect.poll(() => bridgeCalls(page)).toEqual(["open:proj_alt:new"]);
  await expect(page).toHaveURL(/#\/projects\/proj_main$/);

  // A modifier-click on the row does the same.
  await page.getByTestId("project-switcher").click();
  await alt.locator("button").first().click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => bridgeCalls(page)).toEqual(["open:proj_alt:new", "open:proj_alt:new"]);

  // All projects focuses the home window through the bridge.
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("project-switcher-all").click();
  await expect.poll(() => bridgeCalls(page)).toContain("home:projects");
});

test("on macOS the top bar is the draggable title bar with clickable controls", async ({ page }) => {
  await installBridge(page, { titleBar: "inset" });
  await page.goto("/#/projects/proj_main");
  const bar = page.getByTestId("top-bar");
  await expect(bar).toBeVisible();
  const region = (testId: string): Promise<string> =>
    page
      .getByTestId(testId)
      .evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"));
  expect(await region("top-bar")).toBe("drag");
  for (const control of [
    "project-switcher",
    "toggle-project-sidebar",
    "toggle-project",
    "project-nav-connections",
    "project-nav-settings",
  ]) {
    expect(await region(control)).toBe("no-drag");
  }
  // The first control clears the traffic lights.
  const switcher = await page.getByTestId("project-switcher").boundingBox();
  expect(switcher?.x ?? 0).toBeGreaterThanOrEqual(80);
  expect((await bar.boundingBox())?.height).toBe(40);
  await page.getByTestId("project-switcher").click();
  await expect(page.getByTestId("project-switcher-menu")).toBeVisible();
  expect(await region("project-switcher-menu")).toBe("no-drag");
});

test("artifact pop-out windows get a minimal title bar", async ({ page }) => {
  await installBridge(page, { titleBar: "inset" });
  await page.goto("/#/projects/proj_main/artifacts/dashboard");
  const bar = page.getByTestId("top-bar");
  await expect(bar).toHaveAttribute("data-variant", "artifact");
  await expect(page.getByTestId("top-bar-artifact")).toHaveText("Stream dashboard");
  await expect(page.getByTestId("top-bar-project")).toHaveText("Main Channel");
  await expect(bar.locator("button")).toHaveCount(0);
  await expect(page.getByTestId("artifact-menu")).toHaveCount(0);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Stream dashboard — Main Channel — Ballast");
});
