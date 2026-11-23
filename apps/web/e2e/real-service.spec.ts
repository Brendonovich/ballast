import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readRealServiceInfo } from "./real-service.ts";

const cursorOf = async (locator: ReturnType<Page["locator"]>): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).cursor);

test("real service: scripts, consent, logs, source, parameters, connections and settings", async ({
  page,
}) => {
  const info = readRealServiceInfo();
  test.skip(info === undefined, "real service was not started by globalSetup");
  if (info === undefined) return;

  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.addInitScript(() => {
    localStorage.setItem("ballast.theme", "dark");
  });
  await page.goto(`${info.url}/?token=${encodeURIComponent(info.token)}`);
  await expect(page.locator("#boot")).toHaveCount(0);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("project-switcher")).not.toHaveValue("");
  await expect(page.getByTestId("script-row").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("project-switcher")).toContainText("E2E Real");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "screenshots/real-01-scripts.png" });

  const tick = page.locator(
    '[data-testid="script-row"][data-script-id="scripts/tick-echo.ts"]',
  );
  await expect(tick).toBeVisible();
  await tick.locator("button").first().click();
  await expect(page.getByTestId("source-panel")).toContainText("Ballast.Param.string", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("log-panel")).toBeVisible();
  await expect(page.getByTestId("script-sidebar")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-02-script.png" });

  const approve = page.getByTestId("approve-consent");
  if (await approve.isVisible()) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-03-consent.png" });
  } else {
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(approve).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-03-consent.png" });
  }
  await approve.click();
  await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("log-line").first()).toBeVisible({ timeout: 20_000 });

  // Edit a parameter from the right sidebar.
  const prefix = page.getByRole("textbox", { name: "Prefix" });
  await prefix.fill(">>");
  await prefix.press("Enter");
  await expect(prefix).toHaveValue(">>");
  await page.waitForTimeout(250);
  await page.screenshot({ path: "screenshots/real-04-script-running.png" });

  // Connection dialog with the real OBS field descriptors.
  await page.getByTestId("nav-connections").click();
  const obs = page.locator(
    '[data-testid="connection-row"][data-connection-id="obs/main"]',
  );
  await expect(obs).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-05-connections.png" });
  await obs.getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("connection-field-url")).toBeVisible();
  expect(await cursorOf(page.getByTestId("connection-field-url"))).not.toBe("pointer");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-06-connection-dialog.png" });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  // Settings reads the real service, not the mock transport.
  await page.getByTestId("nav-settings").click();
  await expect(page.getByText("Transport")).toBeVisible();
  await expect(page.getByText("in-browser mock")).toHaveCount(0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-07-settings.png" });

  // Dark + light evidence for the new Script detail layout on the real service.
  await page.getByTestId("theme-light").click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme))
    .toBe("light");
  await page.getByTestId("nav-scripts").click();
  await page
    .locator('[data-testid="script-row"][data-script-id="scripts/tick-echo.ts"]')
    .locator("button")
    .first()
    .click();
  await expect(page.getByTestId("source-panel")).toContainText("Ballast.Param.string");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-08-script-light.png" });

  expect(errors).toEqual([]);
});
