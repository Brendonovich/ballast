import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const installBridge = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
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
      version: 3,
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
        openProjectWindow: async () => {},
        openArtifactWindow: async () => {},
        openHome: async (route?: string) => {
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
  });
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
  await expect(page.getByTestId("project-rail")).toBeVisible();
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
  await expect(page).toHaveTitle("Connections — Main Channel — Ballast");

  await page.getByTestId("project-back").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main$/);
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  await page.getByTestId("project-nav-settings").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main\/settings$/);
  await page.getByTestId("project-nav-project").click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  // Nothing went through the bridge to open another window.
  expect(page.context().pages().length).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("ballast.bridge.openHome"))).toBeNull();
});
