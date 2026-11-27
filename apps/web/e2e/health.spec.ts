import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Project status and issues against the in-browser mock's own projects:
 * Main Channel (running, failed unit, change not applied), Second Channel
 * (needs you: unbound OBS main, offline OBS secondary) and Failed Channel.
 * The one fixture attaches Main Channel's pending consent to its detail.
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

const fixture = (page: Page, projectId: string, input: unknown): Promise<void> =>
  page.evaluate(
    ({ id, value }) => {
      const hooks: unknown = Reflect.get(window, "ballastMock");
      if (typeof hooks !== "object" || hooks === null) throw new Error("ballastMock is missing");
      const project: unknown = Reflect.get(hooks, "project");
      if (typeof project !== "function") throw new Error("ballastMock.project is missing");
      project.call(hooks, id, value);
    },
    { id: projectId, value: input },
  );

const now = Date.now();

const emptyChanges = { connections: [], topics: [], requests: [], scopes: [], params: [] };

/** The consent the mock lists for Main Channel, attached to its detail. */
const mainConsent = {
  pendingConsent: {
    id: "consent-main",
    projectId: "proj_main",
    projectName: "Main Channel",
    createdAt: now - 20 * 60_000,
    reason: "scopes",
    summary: "Adds scopes: twitch:chat:read",
    diff: {
      requiresConsent: true,
      added: { ...emptyChanges, scopes: ["twitch:chat:read"] },
      removed: emptyChanges,
    },
    bindings: [],
  },
};

const openMain = async (page: Page): Promise<void> => {
  await page.goto("/#/projects/proj_main");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("source-panel")).toContainText("Ballast.Database");
  await expect(page.getByTestId("project-status")).toHaveAttribute("data-issues", "3");
};

const boxOf = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not visible`);
  return box;
};

const toneOf = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('span[aria-hidden="true"]')
    .first()
    .evaluate((element) => [...element.classList].find((name) => name.startsWith("bg-")));

const issue = (page: Page, kind: string) =>
  page.locator(`[data-testid="project-issue"][data-issue-kind="${kind}"]`);

const openIssues = async (page: Page): Promise<void> => {
  await page.getByTestId("project-status").click();
  await expect(page.getByTestId("project-issues")).toBeVisible();
};

const noPreviousVersionText = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/previous version/i);
};

test("the top bar shows one status word and an issues popover without layout shift", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  // Running shows only the issue count.
  const status = page.getByTestId("project-status");
  await expect(status).toHaveText("3 issues");
  // Running with issues is amber, and nothing else sits in the bar's left side.
  expect(await toneOf(page, "project-switcher")).toBe("bg-warning");
  await expect(page.getByTestId("top-bar")).not.toContainText("/Users/streamer");
  await expect(page.getByTestId("project-error")).toHaveCount(0);
  await noPreviousVersionText(page);

  const before = await Promise.all(
    ["project-navigator", "tab-area", "log-panel", "project-sidebar"].map((id) => boxOf(page, id)),
  );
  await openIssues(page);
  const after = await Promise.all(
    ["project-navigator", "tab-area", "log-panel", "project-sidebar"].map((id) => boxOf(page, id)),
  );
  expect(after).toEqual(before);

  // One line per issue, errors first, with a relative time and a muted detail.
  const rows = page.getByTestId("project-issue");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-issue-kind", "change-not-applied");
  await expect(rows.nth(1)).toHaveAttribute("data-issue-kind", "unit-failed");
  await expect(rows.nth(0)).toHaveAttribute("data-severity", "error");
  await expect(rows.nth(2)).toHaveAttribute("data-severity", "warning");
  await expect(rows.nth(0)).toContainText("Latest change not applied");
  await expect(rows.nth(0)).toContainText("ago");
  await expect(issue(page, "unit-failed")).toContainText("Twitch chat request failed");
  await noPreviousVersionText(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-issues")).toHaveCount(0);

  // Several kinds at once, including an offline connection.
  await page.goto("/#/projects/proj_alt");
  await openIssues(page);
  await expect(page.getByTestId("project-issue")).toHaveCount(4);
  await expect(issue(page, "connection-offline")).toContainText("Second PC (secondary) offline");
  await expect(issue(page, "needs-binding")).toBeVisible();
  await page.keyboard.press("Escape");

  // No issues: a new project's popover says so.
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("project-switcher-new").click();
  await page.getByTestId("create-project-name").fill("Quiet Channel");
  await page.getByTestId("create-project-directory").fill("/Users/streamer/Ballast/quiet");
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("project-switcher")).toContainText("Quiet Channel");
  await expect(status).toHaveText("Stopped");
  await expect(status).toHaveAttribute("data-issues", "0");
  expect(await toneOf(page, "project-switcher")).toBe("bg-faint");
  await openIssues(page);
  await expect(page.getByTestId("project-issues-empty")).toHaveText("Everything's working");
  expect(errors).toEqual([]);
});

test("each issue takes you to where it can be seen or fixed", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openMain(page);

  // A change that did not apply: the source line, with a gutter marker.
  await openIssues(page);
  await issue(page, "change-not-applied").click();
  await expect(page.getByTestId("project-issues")).toHaveCount(0);
  const marked = page.locator('[data-line="42"]');
  await expect(marked).toHaveAttribute("data-highlighted", "true");
  await expect(marked).toHaveAttribute("data-marked", "true");
  await expect(marked).toBeInViewport();
  const marker = page.getByTestId("source-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute(
    "aria-label",
    "Latest change not applied: Type 'string' is not assignable to type 'number'.",
  );
  await marker.hover();
  await expect(page.getByTestId("source-marker-tooltip")).toBeVisible();
  await expect(page.getByTestId("source-marker-tooltip")).toContainText("is not assignable");

  // A failed unit: pointed at in the outline (opened for it), logs filtered.
  await page.getByTestId("outline-toggle").click();
  await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-open", "false");
  await openIssues(page);
  await issue(page, "unit-failed").click();
  await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-open", "true");
  const redemption = page.locator('[data-testid="outline-row"][data-unit-name="redemption"]');
  await expect(redemption).toHaveAttribute("data-flash", "true");
  await expect(redemption).toBeInViewport();
  await expect(page.getByTestId("log-unit-filter").locator("option:checked")).toHaveText(
    "Topic · redemption",
  );
  await expect(page.locator('[data-highlighted="true"]')).toContainText('subscribe("redemption"');

  // Consent: the approval panel, focused on Approve.
  await fixture(page, "proj_main", mainConsent);
  await expect(page.getByTestId("project-consent")).toBeVisible();
  await openIssues(page);
  await issue(page, "needs-consent").click();
  await expect(page.getByTestId("project-consent")).toHaveAttribute("data-flash", "true");
  await expect(page.getByTestId("approve-project-consent")).toBeFocused();

  await fixture(page, "proj_main", null);

  // A missing binding: the OBS requirement row (not Fake, which shares the
  // slot name), matched by the issue's integration.
  await page.goto("/#/projects/proj_alt");
  await expect(page.getByTestId("project-status")).toHaveText("Needs you");
  await openIssues(page);
  await issue(page, "needs-binding").click();
  const requirement = page.locator('[data-testid="project-requirement"][data-flash="true"]');
  await expect(requirement).toHaveCount(1);
  await expect(requirement).toHaveAttribute("data-integration", "obs");
  await expect(requirement).toHaveAttribute("data-slot", "main");
  await expect(requirement.getByTestId("project-connection-picker")).toBeFocused();

  // An offline connection: Connections, with its row picked out, same window.
  await openIssues(page);
  await issue(page, "connection-offline").click();
  await expect(page).toHaveURL(/#\/projects\/proj_alt\/connections$/);
  const row = page.locator('[data-testid="connection-row"][data-connection-id="obs/secondary"]');
  await expect(row).toHaveAttribute("data-flash", "true");

  // From Connections an in-project issue returns to the project first.
  await openIssues(page);
  await issue(page, "needs-binding").click();
  await expect(page).toHaveURL(/#\/projects\/proj_alt$/);
  await expect(
    page.locator('[data-testid="project-requirement"][data-integration="obs"][data-slot="main"]'),
  ).toHaveAttribute("data-flash", "true");
  expect(errors).toEqual([]);
});

test("failed and waiting units explain themselves in the outline", async ({ page }) => {
  await useTheme(page, "dark");
  await openMain(page);
  // The failed redemption topic and the failed overlay artifact build.
  await expect(page.getByTestId("outline-failed")).toHaveText("2 failed");
  const failed = page.locator('[data-testid="outline-row"][data-unit-name="redemption"]');
  await expect(failed).toHaveAttribute("data-status", "failed");
  await expect(failed).toHaveAttribute(
    "title",
    /Failed: Twitch chat request failed before the redemption was redeemed/,
  );
  expect(
    await failed
      .locator('span[aria-hidden="true"]')
      .first()
      .evaluate((element) => element.classList.contains("bg-danger")),
  ).toBe(true);

  // A topic waiting on an offline connection names it.
  await page.goto("/#/projects/proj_alt");
  const waiting = page.locator('[data-testid="outline-row"][data-unit-name="scene"]');
  await expect(waiting).toHaveAttribute("data-status", "waiting");
  await expect(waiting).toHaveAttribute(
    "title",
    /Waiting for Second PC \(obs · secondary\), which is offline/,
  );
});

test("the start/stop action follows the real status", async ({ page }) => {
  await useTheme(page, "dark");
  await openMain(page);
  const action = page.getByTestId("toggle-project");
  await expect(action).toHaveText("Stop");
  // Restart lives in Stop's dropdown.
  await expect(page.getByTestId("project-run-menu")).toHaveCount(0);
  await page.getByTestId("project-run-menu").click();
  await expect(page.getByTestId("restart-project")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-run-menu")).toHaveCount(0);

  // Stop and start round-trip through the mock.
  await action.click();
  await expect(page.getByTestId("project-status")).toHaveText("Stopped");
  await expect(action).toHaveText("Start");
  await expect(page.getByTestId("project-run-menu")).toHaveCount(0);
  await action.click();
  await expect(page.getByTestId("project-status")).toHaveText("3 issues");
  await expect(action).toHaveText("Stop");

  // Failed: Start, no Restart, red dot.
  await page.goto("/#/projects/proj_failed");
  await expect(page.getByTestId("project-status")).toHaveText("Failed");
  expect(await toneOf(page, "project-switcher")).toBe("bg-danger");
  await expect(action).toHaveText("Start");
  await expect(page.getByTestId("project-run-menu")).toHaveCount(0);

  // Needs you: Set up… opens the binding flow at the unbound OBS slot.
  await page.goto("/#/projects/proj_alt");
  await expect(action).toHaveText("Set up…");
  await expect(page.getByTestId("project-run-menu")).toHaveCount(0);
  await action.click();
  const flashed = page.locator('[data-testid="project-requirement"][data-flash="true"]');
  await expect(flashed).toHaveAttribute("data-integration", "obs");
  await expect(flashed).toHaveAttribute("data-slot", "main");
});

test("the projects list shows the same status word, dot and issues", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await page.goto("/#/projects");
  await expect(page.getByTestId("project-row")).toHaveCount(3);
  const main = page.locator('[data-testid="project-row"][data-project-id="proj_main"]');
  const alt = page.locator('[data-testid="project-row"][data-project-id="proj_alt"]');
  const failed = page.locator('[data-testid="project-row"][data-project-id="proj_failed"]');
  await expect(main.getByTestId("project-status-word")).toHaveText("Running");
  await expect(main.getByTestId("project-issue-count")).toHaveText("3 issues");
  await expect(main.getByTestId("project-issue-count")).toHaveAttribute(
    "title",
    /Latest change not applied\nredemption failed/,
  );
  await expect(main.getByTestId("project-action")).toHaveText("Stop");
  await expect(alt).toHaveAttribute("data-status", "needs-user");
  await expect(alt.getByTestId("project-status-word")).toHaveText("Needs you");
  await expect(alt.getByTestId("project-action")).toHaveText("Set up…");
  await expect(failed).toHaveAttribute("data-status", "failed");
  await expect(failed.getByTestId("project-status-word")).toHaveText("Failed");
  await expect(failed.getByTestId("project-issue-count")).toHaveText("1 issue");
  expect(
    await failed
      .locator('span[aria-hidden="true"]')
      .first()
      .evaluate((element) => element.classList.contains("bg-danger")),
  ).toBe(true);
  await expect(failed.getByTestId("project-action")).toHaveText("Start");
  await noPreviousVersionText(page);

  // Set up… from the list opens the project at its binding.
  await alt.getByTestId("project-action").click();
  await expect(page).toHaveURL(/#\/projects\/proj_alt$/);
  await expect(
    page.locator('[data-testid="project-requirement"][data-integration="obs"][data-slot="main"][data-flash="true"]'),
  ).toHaveCount(1);
  await noPreviousVersionText(page);
  expect(errors).toEqual([]);
});

const capture = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await useTheme(page, theme);
  await openMain(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `screenshots/${theme}-21-status-amber.png` });
  await page.screenshot({
    path: `screenshots/${theme}-21-status-amber-strip.png`,
    clip: { x: 0, y: 0, width: 720, height: 80 },
  });

  // Second Channel has the widest mix of issue kinds.
  await page.goto("/#/projects/proj_alt");
  await openIssues(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-22-issues-popover.png` });
  await page.screenshot({
    path: `screenshots/${theme}-22-issues-popover-crop.png`,
    clip: { x: 0, y: 0, width: 720, height: 320 },
  });

  await page.keyboard.press("Escape");
  await openMain(page);
  await openIssues(page);
  await issue(page, "change-not-applied").click();
  await page.getByTestId("source-marker").hover();
  await expect(page.getByTestId("source-marker-tooltip")).toBeVisible();
  await page.waitForTimeout(200);
  const line = await page.locator('[data-line="42"]').boundingBox();
  if (line === null) throw new Error("line 42 is not visible");
  await page.screenshot({ path: `screenshots/${theme}-23-change-not-applied.png` });
  await page.screenshot({
    path: `screenshots/${theme}-23-change-not-applied-crop.png`,
    clip: { x: line.x - 8, y: line.y - 60, width: 760, height: 170 },
  });

  await page.goto("/#/projects");
  await expect(page.getByTestId("project-row")).toHaveCount(3);
  await expect(
    page.locator('[data-testid="project-row"][data-project-id="proj_failed"]').getByTestId("project-status-word"),
  ).toHaveText("Failed");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-24-projects-failed.png` });
};

test("captures dark status screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light status screenshots", async ({ page }) => {
  await capture(page, "light");
});
