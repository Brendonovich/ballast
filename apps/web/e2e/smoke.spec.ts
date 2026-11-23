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

const boxOf = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a visible element");
  return box;
};

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
  const detailLayout = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(detailLayout.documentHeight).toBeLessThanOrEqual(detailLayout.viewportHeight + 1);
  expect(await cursorOf(page.getByTestId("approve-consent"))).toBe("default");
  expect(await cursorOf(page.getByTestId("source-panel"))).toBe("default");
  expect(await cursorOf(page.getByTestId("script-splitter"))).toBe("row-resize");
  await expect(page.getByText("Approval required")).toBeVisible();
  await page.getByTestId("approve-consent").click();
  await expect(page.getByTestId("approve-consent")).toHaveCount(0);
  await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();

  await expect(
    page.getByTestId("log-line").filter({ hasText: "consent approved" }).first(),
  ).toBeVisible();
  await expect(page.getByTestId("source-panel")).toContainText("Effect.gen");
  await expect(page.getByTestId("source-panel")).toContainText("cheer-alert");

  // Parameters live in the collapsible right sidebar.
  await expect(page.getByTestId("script-sidebar")).toBeVisible();
  const message = page.getByRole("textbox", { name: "Chat message" });
  await message.fill("Thanks for the raid!");
  await message.press("Enter");
  await expect(message).toHaveValue("Thanks for the raid!");

  // Drag the splitter and check the ratio is persisted.
  const splitter = page.getByTestId("script-splitter");
  const splitterBox = await boxOf(splitter);
  const sourceBefore = await boxOf(page.getByTestId("source-panel"));
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    splitterBox.x + splitterBox.width / 2,
    splitterBox.y + splitterBox.height / 2 + 110,
    { steps: 5 },
  );
  await page.mouse.up();
  const sourceAfter = await boxOf(page.getByTestId("source-panel"));
  expect(sourceAfter.height).toBeGreaterThan(sourceBefore.height + 40);
  const storedSplit = await page.evaluate(() => localStorage.getItem("ballast.scriptSplit"));
  expect(storedSplit === null ? 0 : Number(storedSplit)).toBeGreaterThan(0.58);

  // Maximize/restore each pane; Esc restores.
  await page.getByTestId("source-maximize").click();
  await expect.poll(async () => (await boxOf(page.getByTestId("log-panel"))).height).toBeLessThan(50);
  expect((await boxOf(page.getByTestId("source-panel"))).height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await boxOf(page.getByTestId("log-panel"))).height).toBeGreaterThan(90);

  await page.getByTestId("logs-maximize").click();
  await expect.poll(async () => (await boxOf(page.getByTestId("source-panel"))).height).toBeLessThan(50);
  expect((await boxOf(page.getByTestId("log-panel"))).height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await boxOf(page.getByTestId("source-panel"))).height).toBeGreaterThan(90);

  // Collapse and expand the sidebar.
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("script-sidebar")).toHaveCount(0);
  const collapsedSource = await boxOf(page.getByTestId("source-panel"));
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("script-sidebar")).toBeVisible();
  const expandedSource = await boxOf(page.getByTestId("source-panel"));
  expect(expandedSource.width).toBeLessThan(collapsedSource.width);

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
  await expect(page.getByTestId("source-panel")).toContainText("Effect.gen");
  await expect(page.getByTestId("log-line").first()).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-02-script.png` });

  await page.getByTestId("source-maximize").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-03-script-source.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("logs-maximize").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-04-script-logs.png` });
  await page.keyboard.press("Escape");

  await page.getByTestId("nav-scripts").click();
  await openScript(page, "Cheer Alert");
  await expect(page.getByText("Approval required")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-05-consent.png` });

  await page.getByTestId("nav-connections").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-06-connections.png` });

  await page
    .locator('[data-testid="connection-row"][data-connection-id="obs/main"]')
    .getByRole("button", { name: "Manage" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-07-connection-dialog.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await page.getByTestId("nav-settings").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-08-settings.png` });
};

test("collapses the parameters sidebar in a narrow window", async ({ page }) => {
  await useTheme(page, "dark");
  await page.setViewportSize({ width: 1_000, height: 900 });
  await openScripts(page);
  await openScript(page, "Redeem to Scene");
  await expect(page.getByTestId("script-sidebar")).toHaveCount(0);
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("script-sidebar")).toBeVisible();
});

test("captures dark screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light screenshots", async ({ page }) => {
  await capture(page, "light");
});
