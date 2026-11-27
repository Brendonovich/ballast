import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The project window's workspace in mock mode: Files and Outline on the left,
 * tabs (files, artifacts, topic events) in the middle, logs underneath. Main
 * Channel's redemption topic has more than a page of history.
 */

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
    try {
      localStorage.setItem("ballast.theme", value);
    } catch {
      // Sandboxed artifact frames have an opaque origin.
    }
  }, theme);
};

const openMain = async (page: Page): Promise<void> => {
  await page.goto("/#/projects/proj_main");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("source-panel")).toContainText("Ballast.Database");
};

const tab = (page: Page, key: string) => page.locator(`[data-testid="project-tab"][data-tab="${key}"]`);
const outlineRow = (page: Page, kind: string, name: string) =>
  page.locator(`[data-testid="outline-row"][data-unit-kind="${kind}"][data-unit-name="${name}"]`);
const artifactRow = (page: Page, name: string) =>
  page.locator(`[data-testid="artifact-row"][data-artifact="${name}"]`);
const openRow = (row: Locator) => row.getByRole("button").first().click();
const pinRow = (row: Locator) => row.getByRole("button").first().dblclick();

const tabKeys = (page: Page) =>
  page.getByTestId("project-tab").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tab")));

test("tabs preview, pin, focus what is already open, close and restore after a reload", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  // Nothing opened yet: the entry file.
  expect(await tabKeys(page)).toEqual(["file:ballast.ts"]);
  await expect(tab(page, "file:ballast.ts")).toHaveAttribute("aria-selected", "true");

  // A single click opens a preview tab, which the next single click replaces.
  await openRow(artifactRow(page, "dashboard"));
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("data-preview", "true");
  await openRow(outlineRow(page, "topic", "redemption"));
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "topic:redemption"]);
  await expect(tab(page, "file:ballast.ts")).not.toHaveAttribute("data-preview", "true");

  // A double click on the tab or the row keeps it.
  await tab(page, "topic:redemption").dblclick();
  await expect(tab(page, "topic:redemption")).not.toHaveAttribute("data-preview", "true");
  await pinRow(artifactRow(page, "dashboard"));
  await expect(tab(page, "artifact:dashboard")).not.toHaveAttribute("data-preview", "true");
  await openRow(outlineRow(page, "topic", "redemption"));
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "topic:redemption", "artifact:dashboard"]);
  await expect(tab(page, "topic:redemption")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("topic-events")).toBeVisible();
  await expect(outlineRow(page, "topic", "redemption")).toHaveAttribute("data-selected", "true");

  // Opening something already open focuses its tab.
  await openRow(artifactRow(page, "dashboard"));
  expect(await tabKeys(page)).toHaveLength(3);
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("source-file").filter({ hasText: "ballast.ts" }).click();
  await expect(tab(page, "file:ballast.ts")).toHaveAttribute("aria-selected", "true");
  await tab(page, "artifact:dashboard").click();
  await expect(page.locator('[data-testid="artifact-pane"][data-artifact="dashboard"]')).toBeVisible();

  // Open tabs and the active one survive a reload.
  await page.reload();
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "topic:redemption", "artifact:dashboard"]);
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.frameLocator('[data-artifact="dashboard"] iframe').getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();

  // Closing the active tab focuses its right neighbour, else its left.
  await tab(page, "topic:redemption").click();
  await tab(page, "topic:redemption").getByTestId("project-tab-close").click();
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "artifact:dashboard"]);
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");

  // Middle-click closes too.
  await tab(page, "file:ballast.ts").click({ button: "middle" });
  expect(await tabKeys(page)).toEqual(["artifact:dashboard"]);
  await tab(page, "artifact:dashboard").getByTestId("project-tab-close").click();
  await expect(page.getByTestId("project-tab")).toHaveCount(0);
  await expect(page.getByTestId("tabs-empty")).toBeVisible();

  // Closing everything is remembered rather than reopening the entry file.
  await page.reload();
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("tabs-empty")).toBeVisible();
  await expect(page.getByTestId("project-tab")).toHaveCount(0);

  // Another project keeps its own tabs.
  await page.goto("/#/projects/proj_alt");
  expect(await tabKeys(page)).toEqual(["file:ballast.ts"]);
  expect(errors).toEqual([]);
});

test("a topic tab lists its events, shows one in detail and loads older ones", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  await openRow(outlineRow(page, "topic", "redemption"));

  const view = page.getByTestId("topic-events");
  await expect(view).toHaveAttribute("data-state", "on");
  const rows = page.getByTestId("topic-event");
  await expect(rows).toHaveCount(50);
  // Newest first.
  await expect(rows.first()).toHaveAttribute("data-cursor", "redemption-64");

  await expect(page.getByTestId("topic-event-detail")).toHaveCount(0);
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  const detail = page.getByTestId("topic-event-detail");
  await expect(detail).toHaveAttribute("data-cursor", "redemption-64");
  await expect(page.getByTestId("topic-event-json")).toContainText('"title": "Hydrate"');

  // Arrow keys move through the list.
  await page.getByTestId("topic-event-list").press("ArrowDown");
  await expect(detail).toHaveAttribute("data-cursor", "redemption-63");

  // Load older pages back to the start of the history.
  await page.getByTestId("topic-events-older").click();
  await expect(rows).toHaveCount(64);
  await expect(rows.last()).toHaveAttribute("data-cursor", "redemption-1");
  await expect(page.getByTestId("topic-events-older")).toHaveCount(0);
  // Polling leaves loaded pages and the selection alone.
  await page.waitForTimeout(2_500);
  await expect(rows).toHaveCount(64);
  await expect(detail).toHaveAttribute("data-cursor", "redemption-63");
  expect(errors).toEqual([]);
});

test("View mode shows only artifacts and parameters and persists per project", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  const view = page.getByTestId("project-mode-view");
  const develop = page.getByTestId("project-mode-develop");
  await expect(develop).toHaveAttribute("aria-pressed", "true");
  await expect(view).toHaveAttribute("aria-pressed", "false");

  await view.click();
  await expect(view).toHaveAttribute("aria-pressed", "true");

  // No Files, Outline, tabs, editor or logs.
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);
  await expect(page.getByTestId("files-panel")).toHaveCount(0);
  await expect(page.getByTestId("outline-panel")).toHaveCount(0);
  await expect(page.getByTestId("tab-area")).toHaveAttribute("data-mode", "view");
  await expect(page.getByTestId("project-tabs")).toBeHidden();
  await expect(page.getByTestId("log-panel")).toBeHidden();
  await expect(page.getByTestId("toggle-project-sidebar")).toBeEnabled();
  await expect(page.getByTestId("toggle-left-sidebar")).toBeVisible();
  await expect(page.getByTestId("toggle-left-sidebar")).toBeDisabled();

  // Artifacts as tabs across the top, the selected one below, parameters on the right.
  await expect(page.getByTestId("artifact-list")).toBeVisible();
  await expect(page.getByTestId("artifact-list-row")).toHaveCount(2);
  const dashboard = page.locator('[data-testid="artifact-list-row"][data-artifact="dashboard"]');
  const overlay = page.locator('[data-testid="artifact-list-row"][data-artifact="overlay"]');
  await expect(dashboard).toHaveAttribute("data-selected", "true");
  await expect(
    page
      .frameLocator('[data-testid="artifact-pane"][data-artifact="dashboard"] iframe')
      .getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(page.getByTestId("project-param-holdSeconds")).toBeVisible();
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(
    page.locator('[data-testid="project-sidebar-section"][data-section="connections"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-sidebar-section"][data-section="timers"]'),
  ).toHaveCount(0);

  // Selecting another artifact shows it, including a build error.
  const dashboardFrame = page.locator('[data-testid="artifact-pane"][data-artifact="dashboard"] iframe');
  await dashboardFrame.evaluate((frame) => frame.setAttribute("data-kept", "true"));
  await overlay.click();
  await expect(overlay).toHaveAttribute("data-selected", "true");
  await expect(dashboard).not.toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-testid="artifact-pane"][data-artifact="overlay"]')).toContainText("Artifact build failed");

  // A shown artifact stays loaded: back to it, and across a mode switch.
  await dashboard.click();
  await expect(dashboardFrame).toBeVisible();
  await expect(dashboardFrame).toHaveAttribute("data-kept", "true");
  await page.getByTestId("project-mode-develop").click();
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  await expect(dashboardFrame).toBeHidden();
  // Develop's artifact tab shows the same page View loaded, not a second copy.
  await pinRow(artifactRow(page, "dashboard"));
  await expect(dashboardFrame).toBeVisible();
  await expect(dashboardFrame).toHaveAttribute("data-kept", "true");
  await expect(page.locator('[data-artifact="dashboard"] iframe')).toHaveCount(1);
  await tab(page, "file:ballast.ts").click();
  await page.getByTestId("project-mode-view").click();
  await expect(dashboardFrame).toBeVisible();
  await expect(dashboardFrame).toHaveAttribute("data-kept", "true");

  // View is remembered across a reload; Develop's tabs were not touched.
  await page.reload();
  await expect(page.getByTestId("project-mode-view")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("artifact-list")).toBeVisible();
  await expect(page.getByTestId("project-tabs")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("ballast.projectMode.proj_main"))).toBe("view");

  await page.getByTestId("project-mode-develop").click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  await expect(page.getByTestId("project-tab")).toHaveCount(2);

  // Another project keeps its own mode and defaults to Develop.
  await page.goto("/#/projects/proj_alt");
  await expect(page.getByTestId("project-mode-develop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("artifact-list")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Open in lists installed apps and configured agents, and remembers the last choice", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  const primary = page.getByTestId("open-in-primary");
  await expect(primary).toBeVisible();
  // No agent is configured yet, so OpenCode Desktop is the default.
  await expect(primary).toHaveAttribute("title", "Open in OpenCode");

  await page.getByTestId("open-in-menu").click();
  const options = page.getByTestId("open-in-options");
  await expect(options).toBeVisible();
  await expect(options.locator('[data-agent]')).toHaveCount(0);
  await expect(options.locator('[data-opener="ghostty"]')).toBeVisible();
  await expect(options.locator('[data-opener="files"]')).toContainText("Finder");

  // Configuring Claude Code adds it, started in the first terminal that can run agents.
  await page.getByTestId("open-in-configure-agents").click();
  await page.getByTestId("agent-option-opencode").click();
  await page.getByTestId("agent-option-claude-code").click();
  await page.getByTestId("write-agent-configs").click();
  await expect(page.getByTestId("agent-start-claude-code")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByTestId("open-in-menu").click();
  const claude = options.locator('[data-agent="claude-code"]');
  await expect(claude).toContainText("Claude Code");
  await expect(claude).toContainText("in Ghostty");
  await claude.click();
  await expect(options).toHaveCount(0);
  await expect(primary).toHaveAttribute("title", "Open in Claude Code in Ghostty");
  expect(await page.evaluate(() => localStorage.getItem("ballast.openIn"))).toBe("ghostty:claude-code");

  // View mode has no Open button.
  await page.getByTestId("project-mode-view").click();
  await expect(page.getByTestId("open-in")).toHaveCount(0);
  expect(errors).toEqual([]);
});
