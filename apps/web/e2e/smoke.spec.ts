import { execFile } from "node:child_process";
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
    try {
      localStorage.setItem("ballast.theme", value);
    } catch {
      // Sandboxed artifact frames have an opaque origin.
    }
  }, theme);
};

const openProjects = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#boot")).toHaveCount(0);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("project-row").first()).toBeVisible();

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

const composeSideBySide = async (
  left: string,
  right: string,
  output: string,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        left,
        "-i",
        right,
        "-filter_complex",
        "[0:v]scale=720:-1[a];[1:v]scale=720:-1[b];[a][b]hstack=inputs=2",
        output,
      ],
      (error) => resolve(error === null ? undefined : undefined),
    );
  });
};

const boxOf = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a visible element");
  return box;
};

const openProject = async (page: Page, name: string): Promise<void> => {
  const row = page.getByTestId("project-row").filter({ hasText: name });
  await row.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByTestId("units-panel")).toBeVisible();
};

const goHome = async (page: Page): Promise<void> => {
  const compact = page.getByTestId("project-nav-projects");
  if (await compact.isVisible().catch(() => false)) {
    await compact.click();
  } else {
    await page.getByTestId("nav-projects").click();
  }
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
};

const goConnections = async (page: Page): Promise<void> => {
  const compact = page.getByTestId("project-nav-connections");
  if (await compact.isVisible().catch(() => false)) {
    await compact.click();
  } else {
    await page.getByTestId("nav-connections").click();
  }
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
};

test("reduced mock workspace: projects, units, source, logs and a connection dialog", async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openProjects(page);

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  expect(await cursorOf(page.getByTestId("project-row").first())).toBe("default");
  expect(await cursorOf(page.getByTestId("nav-projects"))).toBe("default");
  await expect(page.getByTestId("sidebar-project")).toHaveCount(0);

  await openProject(page, "Main Channel");
  await expect(page).toHaveTitle("Main Channel — Ballast");
  await expect(page.getByTestId("project-nav-projects")).toBeVisible();
  await expect(page.getByTestId("sidebar-project")).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(await cursorOf(page.getByTestId("source-panel"))).toBe("default");
  expect(await cursorOf(page.getByTestId("project-splitter"))).toBe("row-resize");
  await expect(page.getByTestId("unit-row").first()).toBeVisible();
  await expect(page.getByTestId("source-panel")).toContainText("mock source");
  await expect(page.getByTestId("log-line").first()).toBeVisible();

  // Artifacts are listed beside units; opening one replaces source and logs.
  const artifactRow = page
    .getByTestId("artifact-row")
    .filter({ hasText: "Stream dashboard" });
  await expect(artifactRow).toHaveAttribute("data-status", "ready");
  await expect(artifactRow).toContainText("Ready · dashboard");
  await expect(artifactRow.getByTestId("artifact-source")).toContainText("main.tsx:12");
  await artifactRow.getByRole("button").first().click();
  await expect(page.getByTestId("artifact-panel")).toBeVisible();
  await expect(page.getByTestId("source-panel")).toHaveCount(0);
  await expect(page.getByTestId("log-panel")).toHaveCount(0);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();

  // Full screen hides both side panels, and Esc restores them.
  await page.getByTestId("artifact-fullscreen").click();
  await expect(page.getByTestId("units-panel")).toHaveCount(0);
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("units-panel")).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();

  // Persistent URLs sit behind the overflow menu; action URLs need approval.
  await page.getByTestId("artifact-menu").click();
  await page.getByTestId("artifact-urls").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("artifact-url-create").click();
  await expect(page.getByTestId("artifact-url-copy")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "http://127.0.0.1:49490/a/mock-read-token/index.html",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("artifact-url-copy").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("mock-read-token");
  await page.getByTestId("artifact-url-scope").selectOption("action");
  await page.getByTestId("artifact-url-create").click();
  await expect(page.getByTestId("artifact-url-confirmation")).toBeVisible();
  await page
    .getByTestId("artifact-url-confirmation")
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(page.getByTestId("artifact-url-copy-value")).toContainText(
    "mock-action-token",
  );
  await page.getByTestId("artifact-url-copy").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("mock-action-token");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

  // Back returns to source and logs.
  await page
    .getByTestId("artifact-panel")
    .getByRole("button", { name: "Back to source" })
    .click();
  await expect(page.getByTestId("source-panel")).toBeVisible();
  await expect(page.getByTestId("log-panel")).toBeVisible();
  await expect(page.getByTestId("artifact-panel")).toHaveCount(0);

  // A failed build links its file:line to the source viewer.
  const failedArtifact = page
    .getByTestId("artifact-row")
    .filter({ hasText: "Alert overlay" });
  await expect(failedArtifact).toHaveAttribute("data-status", "error");
  await expect(failedArtifact.getByTestId("artifact-error-source")).toContainText(
    "main.ts:9",
  );
  await failedArtifact.getByRole("button").first().click();
  await expect(page.getByTestId("artifact-panel")).toContainText("Artifact build failed");
  await expect(page.getByTestId("artifact-panel")).toContainText("Expected a closing tag");
  await expect(page.getByTestId("artifact-panel-error-source")).toContainText("main.ts:9");
  await page
    .getByTestId("artifact-panel")
    .getByRole("button", { name: "Back to source" })
    .click();
  await expect(page.getByTestId("source-panel")).toBeVisible();

  // A plain browser opens the artifact route in its own tab.
  await artifactRow.getByRole("button").first().click();
  await page.getByTestId("artifact-menu").click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("artifact-popout").click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/#\/projects\/proj_main\/artifacts\/dashboard/);
  await expect(popup.getByTestId("artifact-panel")).toBeVisible();
  await expect(popup).toHaveTitle("Stream dashboard — Main Channel — Ballast");
  await popup.close();
  await page.getByTestId("artifact-panel").getByRole("button", { name: "Back to source" }).click();

  // Clicking a unit selects it as the log filter.
  const firstUnit = page.getByTestId("unit-row").first();
  const unitName = await firstUnit.getAttribute("data-unit-name");
  await firstUnit.getByRole("button").first().click();
  await expect(page.getByTestId("log-unit-filter")).toContainText(unitName ?? "");

  // Drag the splitter and check the ratio is persisted.
  const splitter = page.getByTestId("project-splitter");
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
  const storedSplit = await page.evaluate(() => localStorage.getItem("ballast.projectSplit"));
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

  // Collapse and expand the project sidebar.
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  const collapsedSource = await boxOf(page.getByTestId("source-panel"));
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  const expandedSource = await boxOf(page.getByTestId("source-panel"));
  expect(expandedSource.width).toBeLessThan(collapsedSource.width);

  // Create a project in a plain browser: no native picker, just the path field.
  await goHome(page);
  await page.getByTestId("new-project").click();
  await expect(page.getByTestId("create-project-directory-pick")).toHaveCount(0);
  await page.getByTestId("create-project-name").fill("Guest Channel");
  await page.getByTestId("create-project-directory").fill("/Users/streamer/Ballast/guest");
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByRole("heading", { name: "Guest Channel" })).toBeVisible();
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await page.getByTestId("toggle-project").click();
  await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("toggle-project")).toHaveText("Stop");

  // Add an existing folder and open it.
  await goHome(page);
  await page.getByTestId("add-project").click();
  await page.getByTestId("add-project-path").fill("/Users/streamer/Ballast/extra");
  await page.getByTestId("add-project-submit").click();
  await expect(page.getByRole("heading", { name: "extra" })).toBeVisible();

  await goConnections(page);
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
    .getByRole("button", { name: "Manage" })
    .click();
  await page.getByTestId("connection-auth").click();
  const external = page.getByRole("dialog").locator('a[target="_blank"]');
  await expect(external).toBeVisible();
  expect(await cursorOf(external)).toBe("pointer");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  // Add a service-level connection, then delete it while unbound.
  await page.getByTestId("add-connection").click();
  const addDialog = page.getByRole("dialog");
  await addDialog.getByTestId("connection-integration").selectOption("twitch");
  await expect(addDialog).toContainText("http://localhost:17345/callback");
  await expect(addDialog.getByTestId("connection-redirect-copy")).toBeVisible();
  await addDialog.getByTestId("connection-mode").selectOption("cloud");
  await expect(addDialog.getByTestId("cloud-account")).toHaveCount(2);
  await expect(addDialog).toContainText("@streamer");
  await expect(addDialog).toContainText("Reconnect this account");
  await expect(
    addDialog.getByRole("link", { name: /Link another account/ }),
  ).toHaveAttribute("href", "https://cloud.ballast.stream/oauth/twitch/start");
  await addDialog.getByTestId("cloud-account").first().getByRole("radio").check();

  await addDialog.getByTestId("connection-integration").selectOption("fake");
  await page.getByTestId("connection-label").fill("Test Fake");
  await page.getByTestId("create-connection-submit").click();
  const addedDialog = page.getByRole("dialog");
  await expect(addedDialog).toContainText("Test Fake");
  await expect(addedDialog.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  const added = page.getByTestId("connection-row").filter({ hasText: "Test Fake" });
  await expect(added).toBeVisible();
  await added.getByRole("button", { name: "Delete Test Fake" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(added).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("refreshes the artifact view token before it expires", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("ballast.theme", "dark");
      localStorage.setItem("ballast.mockArtifactTtlMs", "38000");
    } catch {
      // Sandboxed artifact frames have an opaque origin.
    }
  });
  await openProjects(page);
  await openProject(page, "Main Channel");
  await page.getByTestId("artifact-row").getByRole("button").first().click();
  const iframe = page.locator("iframe");
  const first = await iframe.getAttribute("src");
  expect(first).toContain("token=");
  await expect
    .poll(() => iframe.getAttribute("src"), { timeout: 15_000 })
    .not.toBe(first);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
});

const capture = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await useTheme(page, theme);
  await openProjects(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-01-projects.png` });
  await page.screenshot({ path: `screenshots/${theme}-home.png` });

  await page.getByTestId("new-project").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-02-new-project.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await openProject(page, "Main Channel");
  await expect(page.getByTestId("unit-row").first()).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-03-project.png` });
  await page.screenshot({ path: `screenshots/${theme}-project-window.png` });

  const secondWindow = await page.context().newPage();
  await secondWindow.goto("/#/projects/proj_alt");
  await expect(secondWindow.getByTestId("units-panel")).toBeVisible();
  await secondWindow.waitForTimeout(150);
  await secondWindow.screenshot({
    path: `screenshots/${theme}-project-second.png`,
  });
  await secondWindow.close();
  await composeSideBySide(
    `screenshots/${theme}-03-project.png`,
    `screenshots/${theme}-project-second.png`,
    `screenshots/${theme}-two-windows.png`,
  );

  // Artifacts: list, open, full screen and URL management.
  await expect(page.getByTestId("artifact-row").first()).toBeVisible();
  await page.screenshot({ path: `screenshots/${theme}-08-artifacts.png` });
  await page.getByTestId("artifact-row").first().getByRole("button").first().click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-09-artifact.png` });
  await page.getByTestId("artifact-fullscreen").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-10-artifact-fullscreen.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("artifact-menu").click();
  await page.getByTestId("artifact-urls").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-11-artifact-urls.png` });
  await page.getByTestId("artifact-url-scope").selectOption("action");
  await page.getByTestId("artifact-url-create").click();
  await expect(page.getByTestId("artifact-url-confirmation")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-12-artifact-url-confirm.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await page
    .getByTestId("artifact-panel")
    .getByRole("button", { name: "Back to source" })
    .click();

  await page.getByTestId("source-maximize").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-04-source.png` });
  await page.keyboard.press("Escape");

  await page.getByTestId("logs-maximize").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-05-logs.png` });
  await page.keyboard.press("Escape");

  await goConnections(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-06-connections.png` });

  await page.getByTestId("nav-settings").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-07-settings.png` });
};

test("collapses the project sidebar in a narrow window", async ({ page }) => {
  await useTheme(page, "dark");
  await page.setViewportSize({ width: 1_000, height: 900 });
  await openProjects(page);
  await openProject(page, "Main Channel");
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
});

test("captures dark screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light screenshots", async ({ page }) => {
  await capture(page, "light");
});
