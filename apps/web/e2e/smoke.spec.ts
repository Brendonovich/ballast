import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const collectPageErrors = (page: Page): Array<string> => {
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
};

const useTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await page.addInitScript((value) => {
    localStorage.setItem("ballast.theme", value);
  }, theme);
};

const openScripts = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#boot")).toHaveCount(0);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toBeVisible();
  await expect(page.getByTestId("script-row").first()).toBeVisible();

  const layout = await page.evaluate(() => ({
    shellTop: document.querySelector('[data-testid="app-shell"]')?.getBoundingClientRect().top,
    shellHeight: document
      .querySelector('[data-testid="app-shell"]')
      ?.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(layout.shellTop).toBe(0);
  expect(layout.shellHeight).toBe(layout.viewportHeight);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
};

const cursorOf = async (locator: Locator): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).cursor);

const openScript = async (page: Page, name: string): Promise<void> => {
  await page
    .getByTestId("script-row")
    .filter({ hasText: name })
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
};

test("reduced mock workspace: switch project, start/stop, approve consent, logs, source and a connection dialog", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openScripts(page);

  await expect(page.getByTestId("project-switcher")).toHaveValue("proj_main");
  expect(await cursorOf(page.getByTestId("project-switcher"))).toBe("default");
  expect(await cursorOf(page.getByTestId("nav-scripts"))).toBe("default");
  expect(await cursorOf(page.getByTestId("script-row").first())).toBe("default");
  await page.getByTestId("project-switcher").selectOption("proj_alt");
  await expect(page.getByTestId("project-switcher")).toHaveValue("proj_alt");
  await expect(
    page.locator('[data-testid="script-row"][data-script-id="scripts/tick-echo.ts"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="script-row"][data-script-id="scripts/redeem-to-scene.ts"]'),
  ).toHaveCount(0);

  const tick = page.locator(
    '[data-testid="script-row"][data-script-id="scripts/tick-echo.ts"]',
  );
  await tick.getByRole("button", { name: "Start" }).click();
  await expect(tick.getByText("Running")).toBeVisible();
  await tick.getByRole("button", { name: "Stop" }).click();
  await expect(tick.getByText("Stopped")).toBeVisible();

  await page.getByTestId("project-switcher").selectOption("proj_main");
  await openScript(page, "Cheer Alert");
  expect(await cursorOf(page.getByTestId("tab-logs"))).toBe("default");
  expect(await cursorOf(page.getByTestId("approve-consent"))).toBe("default");
  await expect(page.getByText("Approval required")).toBeVisible();
  await expect(page.getByTestId("approve-consent")).toBeVisible();
  await page.getByTestId("approve-consent").click();
  await expect(page.getByTestId("approve-consent")).toHaveCount(0);
  await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();

  await page.getByTestId("tab-logs").click();
  await expect(
    page.getByTestId("log-line").filter({ hasText: "consent approved" }).first(),
  ).toBeVisible();

  await page.getByTestId("tab-source").click();
  await expect(page.getByTestId("source-panel")).toContainText("Effect.gen");
  await expect(page.getByTestId("source-panel")).toContainText("cheer-alert");

  await page.getByTestId("nav-connections").click();
  await page
    .locator('[data-testid="connection-row"][data-connection-id="obs/main"]')
    .getByRole("button", { name: "Manage" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("connection-field-url")).toHaveValue("ws://127.0.0.1:4455");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page
    .locator('[data-testid="connection-row"][data-connection-id="twitch/bot"]')
    .getByRole("button", { name: "Sign in" })
    .click();
  await page.getByTestId("connection-auth").click();
  const external = page.getByRole("dialog").locator('a[target="_blank"]');
  await expect(external).toBeVisible();
  expect(await cursorOf(external)).toBe("pointer");

  expect(errors).toEqual([]);
});

const capture = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await useTheme(page, theme);
  await openScripts(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-01-scripts.png` });

  await openScript(page, "Redeem to Scene");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-02-script.png` });

  await page.getByTestId("tab-source").click();
  await expect(page.getByTestId("source-panel")).toContainText("Effect.gen");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-03-source.png` });

  await page.getByTestId("nav-scripts").click();
  await openScript(page, "Cheer Alert");
  await expect(page.getByText("Approval required")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-04-consent.png` });

  await page.getByTestId("nav-connections").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-05-connections.png` });

  await page
    .locator('[data-testid="connection-row"][data-connection-id="obs/main"]')
    .getByRole("button", { name: "Manage" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-06-connection-dialog.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await page.getByTestId("nav-settings").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-07-settings.png` });
};

test("captures dark screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light screenshots", async ({ page }) => {
  await capture(page, "light");
});
