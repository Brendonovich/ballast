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
  await expect(page.getByTestId("project-navigator")).toBeVisible();
};

const goHome = async (page: Page): Promise<void> => {
  const switcher = page.getByTestId("project-switcher");
  if (await switcher.isVisible().catch(() => false)) {
    await switcher.click();
    await page.getByTestId("project-switcher-all").click();
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

test("reduced mock workspace: projects, artifacts, outline, source, logs and a connection dialog", async ({
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
  await expect(page.getByTestId("top-bar")).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toContainText("Main Channel");
  await expect(page.getByTestId("project-status")).toHaveText("3 issues");
  // A plain browser has an ordinary bar, not a draggable title bar.
  expect(
    await page
      .getByTestId("top-bar")
      .evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region")),
  ).not.toBe("drag");
  expect(await cursorOf(page.getByTestId("project-switcher"))).toBe("default");
  expect(await cursorOf(page.getByTestId("project-nav-connections"))).toBe("default");
  await expect(page.getByTestId("sidebar-project")).toHaveCount(0);
  const layout = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(await cursorOf(page.getByTestId("source-panel"))).toBe("default");
  expect(await cursorOf(page.getByTestId("project-splitter"))).toBe("row-resize");
  await expect(page.getByTestId("source-panel")).toContainText('Ballast.Database("main")');
  await expect(page.getByTestId("log-line").first()).toBeVisible();

  // The entry file is the default tab; Files and the Outline start open.
  await expect(page.getByTestId("project-tab")).toHaveCount(1);
  await expect(page.getByTestId("project-tab")).toHaveAttribute("data-tab", "file:ballast.ts");
  await expect(page.getByTestId("files-panel")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("view-source")).toHaveCount(0);
  expect(await cursorOf(page.getByTestId("outline-toggle"))).toBe("default");
  expect(await cursorOf(page.getByTestId("project-tab").first())).toBe("default");

  // Artifacts lead the outline; opening one adds a tab, logs stay underneath.
  const artifactRow = page
    .getByTestId("artifact-row")
    .filter({ hasText: "Stream dashboard" });
  await expect(artifactRow).toHaveAttribute("data-status", "ready");
  await expect(artifactRow.getByTestId("artifact-source")).toHaveAttribute("title", /ballast\.ts:\d+/);
  expect(await cursorOf(artifactRow.getByRole("button").first())).toBe("default");
  await artifactRow.getByRole("button").first().click();
  await expect(page.getByTestId("artifact-panel")).toBeVisible();
  await expect(artifactRow).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("project-tab")).toHaveCount(2);
  await expect(page.getByTestId("source-panel")).toHaveCount(0);
  await expect(page.getByTestId("log-panel")).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();

  // Full screen hides the sidebars, tabs and logs, and Esc restores them.
  await page.getByTestId("artifact-fullscreen").click();
  await expect(page.getByTestId("project-navigator")).toHaveCount(0);
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("project-tabs")).toHaveCount(0);
  await expect(page.getByTestId("log-panel")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(page.getByTestId("project-tabs")).toBeVisible();

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

  // A plain browser opens the artifact route in its own tab.
  await page.getByTestId("artifact-menu").click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("artifact-popout").click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/#\/projects\/proj_main\/artifacts\/dashboard/);
  await expect(popup.getByTestId("artifact-panel")).toBeVisible();
  await expect(popup).toHaveTitle("Stream dashboard — Main Channel — Ballast");
  await popup.close();

  // A failed build: a red dot on its tab, and its file:line opens the source.
  const failedArtifact = page
    .getByTestId("artifact-row")
    .filter({ hasText: "Alert overlay" });
  await expect(failedArtifact).toHaveAttribute("data-status", "error");
  await expect(failedArtifact.getByTestId("artifact-error-source")).toHaveAttribute("title", /main\.ts:9/);
  // Pinned, so opening its source below adds a tab instead of replacing it.
  await failedArtifact.getByRole("button").first().dblclick();
  const failedPanel = page.locator('[data-testid="artifact-pane"][data-artifact="overlay"]');
  await expect(failedPanel.getByTestId("artifact-panel")).toContainText("Artifact build failed");
  await expect(failedPanel.getByTestId("artifact-panel")).toContainText("Expected a closing tag");
  await expect(failedPanel.getByTestId("artifact-panel-error-source")).toContainText("main.ts:9");
  await failedPanel.getByTestId("artifact-panel-error-source").click();
  // The mock serves a one-line placeholder for files other than ballast.ts.
  await expect(page.getByTestId("source-panel")).toHaveAttribute("data-path", "artifacts/overlay/main.ts");
  // The dashboard was a preview, so the overlay took its place.
  expect(
    await page.getByTestId("project-tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab"))),
  ).toEqual(["file:ballast.ts", "artifact:overlay", "file:artifacts/overlay/main.ts"]);

  // The outline lists artifacts first, then everything else the project declares.
  await expect(page.locator('[data-testid="outline-group"]')).toHaveCount(6);
  for (const group of ["artifact", "topic", "param", "api", "store", "database"]) {
    await expect(page.locator(`[data-testid="outline-group"][data-group="${group}"]`)).toBeVisible();
  }
  const allLines = await page.getByTestId("log-line").count();

  // The log filter is the logs panel's own; a topic tab does not change it.
  await page.getByTestId("log-unit-filter").selectOption({ label: "Topic · redemption" });
  await expect(page.getByTestId("log-line")).toHaveCount(2);
  expect(allLines).toBeGreaterThan(2);
  await expect(page.getByTestId("log-line").first()).toContainText("subscription created");
  await page.getByTestId("log-filter-clear").click();
  await expect(page.getByTestId("log-unit-filter").locator("option:checked")).toHaveText(
    "All units",
  );
  await expect(page.getByTestId("log-line")).toHaveCount(allLines);
  await expect(page.getByTestId("log-filter-clear")).toHaveCount(0);

  // Drag the splitter and check the ratio is persisted.
  await page.getByTestId("source-file").first().click();
  const splitter = page.getByTestId("project-splitter");
  const splitterBox = await boxOf(splitter);
  const tabsBefore = await boxOf(page.getByTestId("tab-area"));
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    splitterBox.x + splitterBox.width / 2,
    splitterBox.y + splitterBox.height / 2 + 110,
    { steps: 5 },
  );
  await page.mouse.up();
  const tabsAfter = await boxOf(page.getByTestId("tab-area"));
  expect(tabsAfter.height).toBeGreaterThan(tabsBefore.height + 40);
  const storedLogs = await page.evaluate(() => localStorage.getItem("ballast.projectLogs.proj_main"));
  const storedSplit: unknown = storedLogs === null ? null : JSON.parse(storedLogs);
  expect(
    typeof storedSplit === "object" && storedSplit !== null ? Reflect.get(storedSplit, "split") : 0,
  ).toBeGreaterThan(0.58);

  // Maximize/restore each pane; Esc restores.
  await page.getByTestId("tabs-maximize").click();
  await expect.poll(async () => (await boxOf(page.getByTestId("log-panel"))).height).toBeLessThan(50);
  expect((await boxOf(page.getByTestId("tab-area"))).height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await boxOf(page.getByTestId("log-panel"))).height).toBeGreaterThan(90);

  await page.getByTestId("logs-maximize").click();
  await expect.poll(async () => (await boxOf(page.getByTestId("tab-area"))).height).toBeLessThan(50);
  expect((await boxOf(page.getByTestId("log-panel"))).height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await boxOf(page.getByTestId("tab-area"))).height).toBeGreaterThan(90);

  // Collapse and expand the project sidebar.
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  const collapsedSource = await boxOf(page.getByTestId("tab-area"));
  await page.getByTestId("toggle-project-sidebar").click();
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  const expandedSource = await boxOf(page.getByTestId("tab-area"));
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

  await page
    .locator('[data-testid="connection-row"][data-connection-id="twitch/broadcaster"]')
    .getByRole("button", { name: "Manage" })
    .click();
  const cloudAuthDialog = page.getByRole("dialog");
  await cloudAuthDialog.getByTestId("connection-auth").click();
  await expect(cloudAuthDialog.getByTestId("connection-auth-check")).toBeVisible();
  await expect(cloudAuthDialog).toContainText("does not need a pairing code");
  await cloudAuthDialog.getByTestId("connection-auth-check").click();
  await expect(cloudAuthDialog.getByTestId("connection-auth-check")).toHaveCount(0);
  await cloudAuthDialog.getByRole("button", { name: "Close" }).click();

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
  await expect(page.getByTestId("source-panel")).toContainText("Ballast.Database");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-03-project.png` });
  await page.getByTestId("outline-toggle").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-13-outline-collapsed.png` });
  await page.getByTestId("outline-toggle").click();
  await expect(page.locator('[data-testid="code-view"][data-highlight="tokens"]')).toBeVisible();
  await page.screenshot({ path: `screenshots/${theme}-16-top-bar.png` });
  await page.screenshot({ path: `screenshots/${theme}-20-source-highlight.png` });
  const codeBox = await boxOf(page.getByTestId("code-view"));
  await page.screenshot({
    path: `screenshots/${theme}-20-source-highlight-crop.png`,
    clip: { x: codeBox.x, y: codeBox.y, width: 700, height: 360 },
  });

  // Logs collapsed to their header, with new lines counted.
  await page.getByTestId("logs-collapse-toggle").click();
  await mockLog(page, "info", "tick 4");
  await mockLog(page, "warn", "OBS scene list is stale");
  await expect(page.getByTestId("logs-new-lines")).toHaveText("2 new");
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-19-logs-collapsed.png` });
  await page.screenshot({
    path: `screenshots/${theme}-19-logs-collapsed-strip.png`,
    clip: { x: 0, y: 900, width: 1440, height: 100 },
  });
  await page.getByTestId("logs-collapse-toggle").click();
  await page.screenshot({
    path: `screenshots/${theme}-16-top-bar-strip.png`,
    clip: { x: 0, y: 0, width: 1440, height: 120 },
  });

  await page.getByTestId("project-switcher").click();
  await expect(page.getByTestId("share-project")).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-17-switcher-open.png` });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `screenshots/${theme}-project-window.png` });

  const secondWindow = await page.context().newPage();
  await secondWindow.goto("/#/projects/proj_alt");
  await expect(secondWindow.getByTestId("project-navigator")).toBeVisible();
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

  // A topic picked in the outline opens its events tab.
  await page
    .locator('[data-testid="outline-row"][data-unit-kind="topic"][data-unit-name="redemption"]')
    .getByRole("button")
    .first()
    .click();
  await expect(page.getByTestId("topic-event").first()).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `screenshots/${theme}-14-outline-selected.png` });
  await page.locator('[data-testid="project-tab"][data-tab="file:ballast.ts"]').click();

  // Connections reached from the top bar of a project window.
  await page.getByTestId("project-nav-connections").click();
  await expect(page.getByTestId("project-section")).toBeVisible();
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${theme}-15-project-connections.png` });
  await page.getByTestId("project-back").click();
  await expect(page.getByTestId("project-navigator")).toBeVisible();

  // An artifact pop-out window: a minimal bar naming the artifact and project.
  const popout = await page.context().newPage();
  await popout.setViewportSize({ width: 960, height: 640 });
  await popout.goto("/#/projects/proj_main/artifacts/dashboard");
  await expect(
    popout.frameLocator("iframe").getByRole("heading", { name: "Stream dashboard" }),
  ).toBeVisible();
  await popout.waitForTimeout(150);
  await popout.screenshot({ path: `screenshots/${theme}-18-artifact-popout.png` });
  await popout.close();

  await page.getByTestId("tabs-maximize").click();
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

  // Settings is a home-window screen only.
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
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

test("reaches Connections from the top bar and returns", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openProjects(page);
  await openProject(page, "Main Channel");
  await expect(page.getByTestId("project-nav-settings")).toHaveCount(0);
  await expect(page.getByTestId("service-status")).toHaveCount(0);

  await page.getByTestId("project-nav-connections").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main\/connections$/);
  await expect(page.getByTestId("project-nav-connections")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
  await expect(page).toHaveTitle("Connections — Main Channel — Ballast");
  await expect(page.getByTestId("connections-attention")).toBeVisible();
  // Project actions belong to the project view only.
  await expect(page.getByTestId("toggle-project")).toHaveCount(0);
  await expect(page.getByTestId("toggle-project-sidebar")).toHaveCount(0);
  await page.getByTestId("project-back").click();
  await expect(page).toHaveURL(/#\/projects\/proj_main$/);
  await expect(page.getByTestId("project-navigator")).toBeVisible();
  await expect(page.getByTestId("toggle-project")).toBeVisible();
  await expect(page).toHaveTitle("Main Channel — Ballast");

  // The service-wide routes still work.
  await page.goto("/#/connections");
  await expect(page.getByTestId("nav-connections")).toBeVisible();
  await expect(page.getByTestId("connection-row").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the project menu shares, creates a project and lists all projects", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openProjects(page);
  await openProject(page, "Main Channel");

  await page.getByTestId("project-switcher").click();
  const menu = page.getByTestId("project-switcher-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("share-project")).toHaveText("Share");
  await expect(page.getByTestId("project-switcher-row")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The top bar's actions no longer carry Share.
  await expect(page.getByTestId("top-bar-actions").getByTestId("share-project")).toHaveCount(0);

  // New project… uses the existing create flow, then shows the new project.
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("project-switcher-new").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("create-project-name").fill("Switcher Channel");
  await page.getByTestId("create-project-directory").fill("/Users/streamer/Ballast/switcher");
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("project-switcher")).toContainText("Switcher Channel");
  await expect(page).toHaveTitle("Switcher Channel — Ballast");

  // All projects goes to the projects list.
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("project-switcher-all").click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByTestId("project-row")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("source highlighting is consistent and keeps line jumps", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openProjects(page);
  await openProject(page, "Main Channel");
  const code = page.locator('[data-testid="code-view"][data-highlight="tokens"]');
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute("data-highlight-ms", /\d+/);

  // Every token text maps to the set of colors it is painted with.
  const colors = await code.evaluate((element) => {
    const map: Record<string, Array<string>> = {};
    for (const span of element.querySelectorAll("code span")) {
      const text = (span.textContent ?? "").trim();
      if (text === "") continue;
      const color = getComputedStyle(span).color;
      // Keys are recorded as "key:" so member access (event.reward.title) stays separate.
      const next = (span.nextElementSibling?.textContent ?? "").trim();
      const key = next.startsWith(":") ? `${text}:` : text;
      const list = map[key] ?? [];
      if (!list.includes(color)) list.push(color);
      map[key] = list;
    }
    return map;
  });
  const one = (text: string): string => {
    const list = colors[text] ?? [];
    expect(list, text).toHaveLength(1);
    return list[0] ?? "";
  };
  // yield* and function* are keywords like export/default/satisfies.
  expect(one("yield*")).toBe(one("function*"));
  expect(one("export")).toBe(one("yield*"));
  expect(one("satisfies")).toBe(one("yield*"));
  // Namespaces are one color wherever they appear.
  expect(one("Ballast")).toBe(one("OBS"));
  // Keys are one color, distinct from keywords and strings.
  expect(one("title:")).toBe(one("default:"));
  expect(one("title:")).toBe(one("entry:"));
  expect(one("title:")).not.toBe(one("yield*"));

  // The outline's code icon still highlights and scrolls to a declaration.
  const cheer = page.locator('[data-testid="outline-row"][data-unit-kind="topic"][data-unit-name="cheer"]');
  await cheer.hover();
  await cheer.getByTestId("outline-source").click();
  const target = page.locator('[data-highlighted="true"]');
  await expect(target).toContainText('subscribe("cheer"');
  await expect(target).toBeInViewport();
  await expect(target.locator("span").first()).toBeVisible();
  expect(errors).toEqual([]);
});

/** Mock mode: append a line to the current project's logs. */
const mockLog = (page: Page, level: "info" | "warn" | "error", message: string): Promise<void> =>
  page.evaluate(
    ({ level: value, message: text }) => {
      const hooks: unknown = Reflect.get(window, "ballastMock");
      if (typeof hooks !== "object" || hooks === null) throw new Error("ballastMock is missing");
      const log: unknown = Reflect.get(hooks, "log");
      if (typeof log !== "function") throw new Error("ballastMock.log is missing");
      log.call(hooks, { level: value, message: text });
    },
    { level, message },
  );

test("the logs panel collapses to its header and counts new lines", async ({ page }) => {
  const errors = collectPageErrors(page);
  await useTheme(page, "dark");
  await openProjects(page);
  await openProject(page, "Main Channel");
  const logs = page.getByTestId("log-panel");
  const toggle = page.getByTestId("logs-collapse-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await cursorOf(toggle)).toBe("default");
  const sourceOpen = await boxOf(page.getByTestId("tab-area"));

  // Collapse: only the header bar stays, the source pane takes the height.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("log-line")).toHaveCount(0);
  await expect(page.getByTestId("project-splitter")).toHaveCount(0);
  await expect.poll(async () => (await boxOf(logs)).height).toBeLessThan(40);
  expect((await boxOf(page.getByTestId("tab-area"))).height).toBeGreaterThan(
    sourceOpen.height + 150,
  );
  await expect(logs).toContainText("Live");
  await expect(page.getByTestId("logs-new-lines")).toHaveCount(0);

  // New lines are counted, tinted by the worst level.
  await mockLog(page, "info", "collapsed info");
  await expect(page.getByTestId("logs-new-lines")).toHaveText("1 new");
  await expect(page.getByTestId("logs-new-lines")).toHaveAttribute("data-level", "info");
  await mockLog(page, "warn", "collapsed warn");
  await expect(page.getByTestId("logs-new-lines")).toHaveText("2 new");
  await expect(page.getByTestId("logs-new-lines")).toHaveAttribute("data-level", "warn");
  await mockLog(page, "error", "collapsed error");
  await mockLog(page, "info", "after the error");
  await expect(page.getByTestId("logs-new-lines")).toHaveText("4 new");
  await expect(page.getByTestId("logs-new-lines")).toHaveAttribute("data-level", "error");

  // A failed unit's issue filters the logs without opening them; the header shows the filter.
  await page.getByTestId("project-status").click();
  await page.locator('[data-testid="project-issue"][data-issue-kind="unit-failed"]').click();
  await expect(page.locator('[data-highlighted="true"]')).toContainText('subscribe("redemption"');
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("log-unit-filter").locator("option:checked")).toHaveText(
    "Topic · redemption",
  );
  await expect(page.getByTestId("log-filter-clear")).toBeVisible();
  // The new lines were not from that unit, so the count follows the filter.
  await expect(page.getByTestId("logs-new-lines")).toHaveCount(0);
  await page.getByTestId("log-filter-clear").click();
  await expect(page.getByTestId("logs-new-lines")).toHaveText("4 new");

  // Collapsed state persists for this project across a reload.
  await page.reload();
  await expect(page.getByTestId("logs-collapse-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("project-splitter")).toHaveCount(0);

  // Expanding restores the previous height and the resize handle.
  await page.getByTestId("logs-collapse-toggle").click();
  await expect(page.getByTestId("logs-collapse-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("project-splitter")).toBeVisible();
  await expect
    .poll(async () => Math.abs((await boxOf(page.getByTestId("tab-area"))).height - sourceOpen.height))
    .toBeLessThan(4);
  await expect(page.getByTestId("log-line").first()).toBeVisible();
  await expect(page.getByTestId("logs-new-lines")).toHaveCount(0);

  // The splitter still resizes, and the new height survives collapse/expand.
  const splitter = await boxOf(page.getByTestId("project-splitter"));
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y - 120, { steps: 5 });
  await page.mouse.up();
  const resized = await boxOf(page.getByTestId("tab-area"));
  expect(resized.height).toBeLessThan(sourceOpen.height - 60);
  await page.getByTestId("logs-collapse-toggle").click();
  await page.getByTestId("logs-collapse-toggle").click();
  await expect
    .poll(async () => Math.abs((await boxOf(page.getByTestId("tab-area"))).height - resized.height))
    .toBeLessThan(4);

  // Maximize still works, including straight from collapsed.
  await page.getByTestId("logs-collapse-toggle").click();
  await page.getByTestId("logs-maximize").click();
  await expect(page.getByTestId("logs-collapse-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => (await boxOf(page.getByTestId("tab-area"))).height).toBeLessThan(50);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-splitter")).toBeVisible();
  await page.getByTestId("tabs-maximize").click();
  await expect(page.getByTestId("logs-collapse-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("logs-collapse-toggle").click();
  await expect(page.getByTestId("project-splitter")).toBeVisible();

  // Another project keeps its own layout.
  await page.goto("/#/projects/proj_alt");
  await expect(page.getByTestId("logs-collapse-toggle")).toHaveAttribute("aria-expanded", "true");
  expect(errors).toEqual([]);
});

test("captures dark screenshots", async ({ page }) => {
  await capture(page, "dark");
});

test("captures light screenshots", async ({ page }) => {
  await capture(page, "light");
});
