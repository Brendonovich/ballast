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

const issue = (page: Page, kind: string) =>
  page.locator(`[data-testid="project-issue"][data-issue-kind="${kind}"]`);

const openIssues = async (page: Page): Promise<void> => {
  await page.getByTestId("project-status").click();
  await expect(page.getByTestId("project-issues")).toBeVisible();
};

test("each issue takes you to where it can be seen or fixed", async ({ page }) => {
  const errors = collectPageErrors(page);
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
  await expect(page.getByTestId("project-status")).toHaveAttribute("data-issues", "4");
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
