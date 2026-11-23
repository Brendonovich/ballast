import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const installBridge = async (page: Page, installed: boolean): Promise<void> => {
  await page.addInitScript((isInstalled) => {
    const status = {
      schemaVersion: 1,
      phase: isInstalled ? "running" : "not-installed",
      installed: isInstalled,
      running: isInstalled,
      supervisor: isInstalled ? "launch-agent" : "none",
      loginItemPath: isInstalled ? "/tmp/ballast.plist" : null,
      installedVersion: isInstalled ? "9.9.9" : null,
      builtVersion: "9.9.9",
      runningVersion: isInstalled ? "9.9.9" : null,
      apiVersion: 1,
      pid: isInstalled ? 4242 : null,
      url: isInstalled ? location.origin : null,
      startedAt: isInstalled ? Date.now() : null,
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
      if (name === "install") {
        return {
          ok: true,
          status: {
            ...status,
            phase: "running",
            installed: true,
            running: true,
            supervisor: "launch-agent",
            installedVersion: "9.9.9",
            runningVersion: "9.9.9",
          },
          message: null,
        };
      }
      return { ok: true, status, message: null };
    };
    Reflect.set(window, "ballast", {
      version: 1,
      service: {
        status: async () => status,
        install: () => action("install"),
        uninstall: () => action("uninstall"),
        start: () => action("start"),
        stop: () => action("stop"),
        restart: () => action("restart"),
      },
      update: {
        status: async () => ({ phase: "idle", version: null, message: null }),
        install: async () => ({
          ok: true,
          state: { phase: "idle", version: null, message: null },
          message: null,
        }),
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
      },
      events: {
        onServiceStatus: (listener: (status: unknown) => void) => {
          Reflect.set(window, "ballastStatusListener", listener);
          return () => {};
        },
        onUpdateStatus: () => () => {},
      },
    });
  }, installed);
};

test("desktop bridge supplies installed/running state and supervisor actions", async ({ page }) => {
  await installBridge(page, true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("nav-settings").click();

  await expect(page.getByText("running", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("9.9.9").first()).toBeVisible();
  await expect(page.getByTestId("service-install")).toHaveCount(0);
  await page.getByText("Advanced").click();
  await expect(page.getByTestId("service-uninstall")).toBeVisible();

  await page.evaluate(() => {
    const listener = Reflect.get(window, "ballastStatusListener");
    if (typeof listener === "function") {
      listener({
        schemaVersion: 1,
        phase: "stopping",
        installed: true,
        running: false,
        supervisor: "launch-agent",
        loginItemPath: "/tmp/ballast.plist",
        installedVersion: "9.9.9",
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
});

test("desktop bridge offers install only when the service is not installed", async ({ page }) => {
  await installBridge(page, false);
  await page.goto("/");
  await page.getByTestId("nav-settings").click();

  await expect(page.getByText("not-installed")).toBeVisible();
  await expect(page.getByTestId("service-install")).toBeVisible();
  await expect(page.getByText("Advanced")).toHaveCount(0);

  await page.getByTestId("service-install").click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ballast.bridge.action")))
    .toBe("install");
  await expect(page.getByTestId("service-install")).toHaveCount(0);
});
