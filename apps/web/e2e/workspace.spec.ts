import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The project window's workspace in mock mode: Files and Outline on the left,
 * tabs (files, artifacts, topic events) in the middle, logs underneath, and
 * the top bar's sidebar toggle. Main Channel's redemption topic has more than
 * a page of history; its cheer topic has history off.
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

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a visible element");
  return box;
};

const tab = (page: Page, key: string) => page.locator(`[data-testid="project-tab"][data-tab="${key}"]`);
const outlineRow = (page: Page, kind: string, name: string) =>
  page.locator(`[data-testid="outline-row"][data-unit-kind="${kind}"][data-unit-name="${name}"]`);
const artifactRow = (page: Page, name: string) =>
  page.locator(`[data-testid="artifact-row"][data-artifact="${name}"]`);
const openRow = (row: Locator) => row.getByRole("button").first().click();

const tabKeys = (page: Page) =>
  page.getByTestId("project-tab").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-tab")));

test("tabs open, focus what is already open, close and restore after a reload", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  // Nothing opened yet: the entry file.
  expect(await tabKeys(page)).toEqual(["file:ballast.ts"]);
  await expect(tab(page, "file:ballast.ts")).toHaveAttribute("aria-selected", "true");

  await openRow(artifactRow(page, "dashboard"));
  await openRow(outlineRow(page, "topic", "redemption"));
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "artifact:dashboard", "topic:redemption"]);
  await expect(tab(page, "topic:redemption")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("topic-events")).toBeVisible();
  await expect(outlineRow(page, "topic", "redemption")).toHaveAttribute("data-selected", "true");

  // Opening something already open focuses its tab.
  await openRow(artifactRow(page, "dashboard"));
  expect(await tabKeys(page)).toHaveLength(3);
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("source-file").filter({ hasText: "ballast.ts" }).click();
  await expect(tab(page, "file:ballast.ts")).toHaveAttribute("aria-selected", "true");
  await tab(page, "artifact:dashboard").click();
  await expect(page.locator('[data-testid="artifact-tab-panel"][data-artifact="dashboard"]')).toBeVisible();

  // Open tabs and the active one survive a reload.
  await page.reload();
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "artifact:dashboard", "topic:redemption"]);
  await expect(tab(page, "artifact:dashboard")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.frameLocator('[data-artifact="dashboard"] iframe').getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();

  // Closing the active tab focuses its right neighbour.
  await tab(page, "artifact:dashboard").getByTestId("project-tab-close").click();
  expect(await tabKeys(page)).toEqual(["file:ballast.ts", "topic:redemption"]);
  await expect(tab(page, "topic:redemption")).toHaveAttribute("aria-selected", "true");

  // Middle-click closes too.
  await tab(page, "file:ballast.ts").click({ button: "middle" });
  expect(await tabKeys(page)).toEqual(["topic:redemption"]);
  await tab(page, "topic:redemption").getByTestId("project-tab-close").click();
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

test("the code icon appears on hover and opens the declaration at its line", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  // Rows show no line numbers.
  const rowTexts = await page
    .locator('[data-testid="outline-row"], [data-testid="artifact-row"]')
    .evaluateAll((elements) => elements.map((element) => element.textContent ?? ""));
  expect(rowTexts.length).toBeGreaterThan(5);
  for (const text of rowTexts) expect(text).not.toMatch(/:\d+|\d+\s*$/);

  await openRow(outlineRow(page, "topic", "redemption"));
  const hold = outlineRow(page, "param", "holdSeconds");
  const icon = hold.getByTestId("outline-source");
  await page.mouse.move(0, 500);
  expect(await icon.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await hold.hover();
  await expect.poll(() => icon.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(icon).toHaveAttribute("title", /^ballast\.ts:\d+$/);
  await icon.click();
  await expect(tab(page, "file:ballast.ts")).toHaveAttribute("aria-selected", "true");
  const highlighted = page.locator('[data-highlighted="true"]');
  await expect(highlighted).toContainText('Param.number("holdSeconds"');
  await expect(highlighted).toBeInViewport();

  // The API row and artifacts have it too.
  const api = page.locator('[data-testid="outline-group"][data-group="api"] [data-testid="outline-row"]');
  await api.hover();
  await api.getByTestId("outline-source").click();
  await expect(page.locator('[data-highlighted="true"]')).toContainText("Ballast.Api.serve");
  await artifactRow(page, "dashboard").hover();
  await artifactRow(page, "dashboard").getByTestId("artifact-source").click();
  await expect(page.locator('[data-highlighted="true"]')).toContainText('Artifact("dashboard"');
  // Code icons open files, not the artifact.
  await expect(page.getByTestId("project-tab")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("only rows that open something react to a click; the API is one row", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  const api = page.locator('[data-testid="outline-group"][data-group="api"] [data-testid="outline-row"]');
  await expect(api).toHaveCount(1);
  await expect(api).toContainText("2 procedures");
  await expect(api).toContainText("Snapshot, ResetCounters");
  await expect(api).toHaveAttribute("title", "2 procedures\nSnapshot\nResetCounters");

  // API, stores and databases only offer their declaration.
  const inert = [
    api,
    page.locator('[data-testid="outline-row"][data-key="store:sceneSwitches"]'),
    outlineRow(page, "database", "main"),
  ];
  const background = (row: Locator) => row.evaluate((element) => getComputedStyle(element).backgroundColor);
  for (const row of inert) {
    await expect(row).toHaveAttribute("data-clickable", "false");
    await expect(row.getByRole("button")).toHaveCount(1);
    const resting = await background(row);
    await row.hover();
    expect(await background(row)).toBe(resting);
    await row.click({ position: { x: 30, y: 10 } });
  }
  expect(await tabKeys(page)).toEqual(["file:ballast.ts"]);
  await expect(page.locator('[data-highlighted="true"]')).toHaveCount(0);
  await expect(page.getByTestId("log-unit-filter").locator("option:checked")).toHaveText("All units");

  // A topic opens its events; a param focuses its field in the Project panel.
  await expect(outlineRow(page, "topic", "cheer")).toHaveAttribute("data-clickable", "true");
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await openRow(outlineRow(page, "param", "holdSeconds"));
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(page.getByTestId("project-param-holdSeconds")).toBeFocused();
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
  await expect(view).toContainText("twitch · broadcaster · twitch/channel.channel_points_custom_reward_redemption.add");
  const rows = page.getByTestId("topic-event");
  await expect(rows).toHaveCount(50);
  await expect(page.getByTestId("topic-events-count")).toHaveText("50+ events");
  // Newest first, one line of JSON each.
  await expect(rows.first()).toHaveAttribute("data-cursor", "redemption-64");
  await expect(rows.first()).toContainText('{"id":"f1c21000"');

  await expect(page.getByTestId("topic-event-detail")).toHaveCount(0);
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  const detail = page.getByTestId("topic-event-detail");
  await expect(detail).toHaveAttribute("data-cursor", "redemption-64");
  await expect(page.getByTestId("topic-event-json")).toContainText('"title": "Hydrate"');
  await expect(page.getByTestId("topic-event-json")).toHaveAttribute("data-highlight", "tokens");

  // Arrow keys move through the list.
  await page.getByTestId("topic-event-list").press("ArrowDown");
  await expect(detail).toHaveAttribute("data-cursor", "redemption-63");

  // Load older pages back to the start of the history.
  await page.getByTestId("topic-events-older").click();
  await expect(rows).toHaveCount(64);
  await expect(rows.last()).toHaveAttribute("data-cursor", "redemption-1");
  await expect(page.getByTestId("topic-events-older")).toHaveCount(0);
  await expect(page.getByTestId("topic-events-count")).toHaveText("64 events");
  // Polling leaves loaded pages and the selection alone.
  await page.waitForTimeout(2_500);
  await expect(rows).toHaveCount(64);
  await expect(detail).toHaveAttribute("data-cursor", "redemption-63");
  expect(errors).toEqual([]);
});

test("topics with history off or nothing recorded say so", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  await openRow(outlineRow(page, "topic", "cheer"));
  await expect(page.getByTestId("topic-events")).toHaveAttribute("data-state", "off");
  await expect(page.getByTestId("topic-events-off")).toContainText("History is off for this topic");
  await expect(page.getByTestId("topic-event")).toHaveCount(0);

  await page.goto("/#/projects/proj_alt");
  await openRow(outlineRow(page, "topic", "scene"));
  await expect(page.getByTestId("topic-events-empty")).toContainText("No events recorded yet");
  await openRow(outlineRow(page, "topic", "tick"));
  await expect(page.getByTestId("topic-event")).toHaveCount(18);
  await expect(page.getByTestId("topic-events-older")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Files and Outline collapse and keep their split", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  const files = page.getByTestId("files-panel");
  const outline = page.getByTestId("outline-panel");
  const outlineOpen = await boxOf(outline);

  await page.getByTestId("files-toggle").click();
  await expect(files).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("files-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("source-tree")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-splitter")).toHaveCount(0);
  expect((await boxOf(outline)).height).toBeGreaterThan(outlineOpen.height + 100);
  expect((await boxOf(files)).height).toBeLessThan(40);

  await page.getByTestId("outline-toggle").click();
  await expect(outline).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("outline-row")).toHaveCount(0);
  expect((await boxOf(outline)).height).toBeLessThan(40);

  // Per project, across a reload.
  await page.reload();
  await expect(files).toHaveAttribute("data-open", "false");
  await expect(outline).toHaveAttribute("data-open", "false");
  await page.getByTestId("files-toggle").click();
  await page.getByTestId("outline-toggle").click();

  // The split between them drags and persists.
  const splitter = await boxOf(page.getByTestId("sidebar-splitter"));
  const filesBefore = await boxOf(files);
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 150, { steps: 5 });
  await page.mouse.up();
  const filesAfter = await boxOf(files);
  expect(filesAfter.height).toBeGreaterThan(filesBefore.height + 100);
  await page.reload();
  await expect(files).toHaveAttribute("data-open", "true");
  await expect.poll(async () => Math.abs((await boxOf(files)).height - filesAfter.height)).toBeLessThan(3);

  await page.goto("/#/projects/proj_alt");
  await expect(page.getByTestId("files-panel")).toHaveAttribute("data-open", "true");
  expect(errors).toEqual([]);
});

test("the top bar toggle and ⌘B / Ctrl+B hide the left sidebar", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  const toggle = page.getByTestId("toggle-left-sidebar");
  // At the far left of the bar, before the project switcher.
  expect((await boxOf(toggle)).x).toBeLessThan((await boxOf(page.getByTestId("project-switcher"))).x);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const before = await boxOf(page.getByTestId("tab-area"));

  await toggle.click();
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect((await boxOf(page.getByTestId("tab-area"))).width).toBeGreaterThan(before.width + 200);

  await page.reload();
  await expect(page.getByTestId("source-panel")).toBeVisible();
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  // Connections and Settings have no left sidebar; the toggle holds its place.
  await page.getByTestId("project-nav-connections").click();
  await expect(page.getByTestId("project-section")).toBeVisible();
  await expect(toggle).toBeHidden();
  await page.keyboard.press("ControlOrMeta+b");
  await page.getByTestId("project-back").click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  expect(errors).toEqual([]);
});

test("an artifact tab keeps its page while another tab is shown", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);
  await openRow(artifactRow(page, "dashboard"));
  const iframe = page.locator('[data-testid="artifact-tab-panel"][data-artifact="dashboard"] iframe');
  await expect(
    page.frameLocator('[data-artifact="dashboard"] iframe').getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error("artifact frame is missing");
  await frame.evaluate(() => Reflect.set(window, "ballastMark", 42));
  const src = await iframe.getAttribute("src");

  // Switch to a file and a topic, then back: same document, same state.
  await tab(page, "file:ballast.ts").click();
  await expect(iframe).toBeHidden();
  await openRow(outlineRow(page, "topic", "redemption"));
  await expect(page.getByTestId("topic-event").first()).toBeVisible();
  await tab(page, "artifact:dashboard").click();
  await expect(iframe).toBeVisible();
  expect(await iframe.getAttribute("src")).toBe(src);
  expect(await frame.evaluate(() => Reflect.get(window, "ballastMark"))).toBe(42);
  expect(errors).toEqual([]);
});

const capture = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await useTheme(page, theme);
  await openMain(page);
  await expect(page.locator('[data-testid="code-view"][data-highlight="tokens"]')).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-25-workspace-default.png` });

  // Several tabs: the entry file, an artifact and a topic, with the file shown.
  await openRow(artifactRow(page, "dashboard"));
  await expect(
    page.frameLocator('[data-artifact="dashboard"] iframe').getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  await openRow(outlineRow(page, "topic", "redemption"));
  await expect(page.getByTestId("topic-event").first()).toBeVisible();
  await tab(page, "artifact:dashboard").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `screenshots/${theme}-26-workspace-tabs.png` });

  // The topic tab with an event selected.
  await tab(page, "topic:redemption").click();
  await page.getByTestId("topic-event").nth(1).click();
  await expect(page.getByTestId("topic-event-json")).toHaveAttribute("data-highlight", "tokens");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-27-topic-events.png` });

  // The left sidebar hidden.
  await page.getByTestId("toggle-left-sidebar").click();
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-28-sidebar-hidden.png` });
  await page.getByTestId("toggle-left-sidebar").click();
  await tab(page, "file:ballast.ts").click();
  await expect(page.getByTestId("source-panel")).toBeVisible();
};

test("captures dark workspace screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light workspace screenshots", async ({ page }) => {
  await capture(page, "light");
});

test.describe("pane close-ups", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const theme of ["dark", "light"] as const) {
    test(`captures ${theme} pane borders and spacing`, async ({ page }) => {
      await useTheme(page, theme);
      await openMain(page);
      await expect(page.locator('[data-testid="code-view"][data-highlight="tokens"]')).toBeVisible();
      await page.waitForTimeout(150);
      // Where the top bar, Files, Outline, the tab area and logs meet.
      const files = await boxOf(page.getByTestId("files-panel"));
      await page.screenshot({
        path: `screenshots/${theme}-29-pane-closeup.png`,
        clip: { x: 0, y: 0, width: files.width + 240, height: files.height + 120 },
      });
      const logs = await boxOf(page.getByTestId("log-panel"));
      await page.screenshot({
        path: `screenshots/${theme}-29-pane-closeup-logs.png`,
        clip: { x: logs.x - 40, y: logs.y - 60, width: 420, height: 160 },
      });
    });
  }
});
