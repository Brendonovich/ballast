import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readRealServiceInfo } from "./real-service.ts";

const installPermissionBridge = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    if (localStorage.getItem("ballast.theme") === null) {
      localStorage.setItem("ballast.theme", "dark");
    }
    Reflect.set(window, "ballast", {
      version: 2,
      windows: {
        context: async () => ({ kind: "home", route: "connections" }),
        openProjectWindow: async () => {},
        openHome: async () => {},
      },
      projects: {
        setMenu: async () => {},
      },
      permissions: {
        status: async () => ({ accessibility: "denied" }),
        requestAccessibility: async () => {
          localStorage.setItem("ballast.permission", "requested");
          return { accessibility: "granted" };
        },
      },
    });
  });
};

const openConnections = async (page: Page, url: string, token: string): Promise<void> => {
  await page.goto(`${url}/?token=${encodeURIComponent(token)}`);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("nav-connections").click();
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
};

const captureDialog = async (
  page: Page,
  connectionId: string,
  approvalKind: string,
  path: string,
): Promise<void> => {
  const row = page.locator(
    `[data-testid="connection-row"][data-connection-id="${connectionId}"]`,
  );
  await expect(row).toHaveAttribute("data-approval", approvalKind);
  await row.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("connection-approval-action")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
};

test("renders VTube Studio and accessibility approvals in dark and light", async ({ page }) => {
  const info = readRealServiceInfo();
  test.skip(info === undefined, "real service was not started by globalSetup");
  if (info === undefined) return;
  const vtsId = info.connections.vts;
  const keyboardId = info.connections.keyboard;
  test.skip(
    !info.approvals.vtuberStudio ||
      !info.approvals.accessibility ||
      vtsId === undefined ||
      keyboardId === undefined,
    "approval fixtures were not available",
  );
  if (vtsId === undefined || keyboardId === undefined) return;

  await installPermissionBridge(page);
  await openConnections(page, info.url, info.token);

  await captureDialog(
    page,
    vtsId,
    "vtuber-studio",
    "screenshots/approvals-vtuber-studio-dark.png",
  );
  const keyboard = page.locator(
    `[data-testid="connection-row"][data-connection-id="${keyboardId}"]`,
  );
  await expect(keyboard).toHaveAttribute("data-approval", "accessibility");
  await keyboard.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Accessibility permission: denied")).toBeVisible();
  await expect(page.getByTestId("connection-approval-action")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/approvals-accessibility-dark.png" });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await page.evaluate(() => localStorage.setItem("ballast.theme", "light"));
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("nav-connections").click();
  await expect(page.getByTestId("connection-row").first()).toBeVisible();

  await captureDialog(
    page,
    vtsId,
    "vtuber-studio",
    "screenshots/approvals-vtuber-studio-light.png",
  );
  const keyboardLight = page.locator(
    `[data-testid="connection-row"][data-connection-id="${keyboardId}"]`,
  );
  await keyboardLight.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Accessibility permission: denied")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/approvals-accessibility-light.png" });

  // The hook must reach the desktop permission request, not a fake UI-only action.
  await page.getByTestId("connection-approval-action").click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ballast.permission")))
    .toBe("requested");
});
