import { expect, test } from "@playwright/test";

/**
 * Onboarding against the in-browser mock. The mock starts with projects, so
 * the flow is opened from Projects → Get started rather than on first run.
 */
test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("creator: create a project and configure coding agents", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByTestId("open-onboarding").click();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Ballast" })).toBeVisible();
  await page.screenshot({ path: "screenshots/onboarding-choose.png" });

  await page.getByTestId("onboarding-create").click();
  await page.getByTestId("onboarding-create-submit").click();
  await expect(page.getByText("Enter a project name.")).toBeVisible();
  await page.getByTestId("onboarding-project-name").fill("Stream Helper");
  await page.getByTestId("onboarding-create-submit").click();

  await expect(page.getByRole("heading", { name: "Configure your coding agent" })).toBeVisible();
  const setup = page.getByTestId("agent-setup");
  await expect(setup.getByTestId("agent-option-opencode")).toHaveAttribute("aria-pressed", "true");
  await setup.getByTestId("agent-option-claude-code").click();
  await expect(setup.getByTestId("write-agent-configs")).toHaveText("Configure 2 agents");
  await setup.getByTestId("write-agent-configs").click();
  await expect(setup.getByTestId("write-agent-configs")).toHaveText("Configured");
  await expect(page.getByTestId("agent-start-opencode")).toContainText(
    "cd /Users/streamer/ballast-projects/stream-helper && opencode",
  );
  await expect(page.getByTestId("agent-start-claude-code")).toContainText("&& claude");
  await expect(page.getByTestId("agent-start-codex")).toHaveCount(0);
  await expect(page.getByTestId("agent-starter-prompt")).toContainText("Stream Helper");
  await page.screenshot({ path: "screenshots/onboarding-connect.png" });

  await page.getByTestId("onboarding-open-project").click();
  await expect(page).toHaveURL(/#\/projects\/proj_\d+$/);
  await expect(page.getByTestId("project-switcher")).toContainText("Stream Helper");

  // The same setup is available later from the project menu.
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("connect-agent").click();
  const dialog = page.getByRole("dialog", { name: "Configure a coding agent" });
  await expect(dialog.getByTestId("agent-option-opencode")).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("write-agent-configs")).toHaveText("Configured");
  await dialog.getByRole("button", { name: "Done" }).click();
});

test("consumer: subscribe with a share link", async ({ page }) => {
  await page.goto("/#/welcome");
  await page.getByTestId("onboarding-consume").click();
  await expect(page.getByTestId("onboarding-share")).toBeVisible();
  await expect(page.getByTestId("onboarding-local")).toBeVisible();
  await page.screenshot({ path: "screenshots/onboarding-consume.png" });

  await page.getByTestId("onboarding-share-link").fill("https://example.com/nope");
  await page.getByTestId("onboarding-subscribe").click();
  await expect(page.getByTestId("onboarding-share")).toContainText("Enter a share link or share code.");

  // A link names its share server; subscribing needs a sign-in there.
  await page.getByTestId("onboarding-share-link").fill("https://share.example/s/ABCD-EFGH-JKLM");
  const share = page.getByTestId("onboarding-share");
  await expect(share).toContainText("Sign in to https://share.example to subscribe.");
  await share.getByTestId("subscribe-sign-in").click();
  await expect(share.getByTestId("subscribe-sign-in")).toHaveCount(0);
  await page.getByTestId("onboarding-subscribe").click();
  await expect(page).toHaveURL(/#\/projects\/proj_\d+$/);
  await expect(page.getByTestId("share-subscribed")).toBeVisible();
});

test("skip leaves onboarding for Projects", async ({ page }) => {
  await page.goto("/#/welcome");
  await page.getByTestId("onboarding-skip").click();
  await expect(page).toHaveURL(/#\/projects$/);
  expect(await page.evaluate(() => localStorage.getItem("ballast.onboardingDismissed"))).toBe("1");
});
