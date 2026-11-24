import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentRuntime } from "../src/agent/client.ts";
import { readRealServiceInfo } from "./real-service.ts";
import { startMockObsServer } from "./mock-obs-server.ts";

const projectSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

const projectBundle = (title: string): string => `import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect, Schema } from "effect";

export const title = "${title}";

const Cooldown = Schema.Struct({ reason: Schema.String });

export default Effect.gen(function* () {
  yield* Ballast.Artifact("dashboard", {
    title: "Stream dashboard",
    entry: "./artifacts/dashboard/main.ts",
  });
  const greeting = yield* Ballast.Param.string("greeting", {
    title: "Greeting",
    description: "Shown in both run logs.",
    default: "hello",
  });
  yield* Ballast.Param.strings("scenes", {
    title: "Scenes",
    description: "Scenes to cycle through.",
    default: ["Game", "BRB"],
  });
  yield* OBS.Connection("main");
  const cooldown = yield* Ballast.Timer.subscribe(
    "cooldown",
    Cooldown,
    (fire) => Effect.log(\`cooldown \${fire.payload.reason}\`),
    {
      title: "Cooldown",
      onStale: "deliver",
      maxAgeMs: 24 * 60 * 60_000,
    },
  );

  yield* Ballast.run("alpha", Effect.gen(function* () {
    yield* cooldown.after("demo", "10 minutes", { reason: "demo" });
    yield* Effect.log(\`\${yield* greeting} from alpha\`);
  }));

  yield* Ballast.run("beta", Effect.gen(function* () {
    yield* Effect.log(\`\${yield* greeting} from beta\`);
  }));
});
`;

const brokenBundle = (): string => `import * as Ballast from "@ballast/core";
import { Effect } from "effect";

const broken: number = "latest change failed";

export default Effect.gen(function* () {
  yield* Ballast.run("broken", Effect.log(\`broken \${broken}\`));
});
`;

const artifactEntry = `export default (root: HTMLElement) => {
  root.style.background = "#0b1020";
  root.style.color = "#e6edf7";
  root.style.minHeight = "100vh";
  root.style.padding = "32px";
  root.style.fontFamily = "ui-sans-serif, system-ui, sans-serif";
  const heading = document.createElement("h1");
  heading.textContent = "E2E artifact";
  const note = document.createElement("p");
  note.textContent = "Served by the real artifact gateway.";
  note.style.color = "#8fa3c4";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Bump counter";
  button.style.marginTop = "16px";
  const counter = document.createElement("output");
  counter.setAttribute("data-testid", "artifact-counter");
  counter.textContent = "0";
  counter.style.marginLeft = "12px";
  let count = 0;
  button.addEventListener("click", () => {
    count += 1;
    counter.textContent = String(count);
  });
  root.replaceChildren(heading, note, button, counter);
};
`;

const tickBundle = (title: string): string => `import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export const title = "${title}";

export default Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  // Fake ticks keep no history by default; chat messages do.
  yield* Fake.Tick.subscribe("tick", fake, (tick) => Effect.log(\`tick \${tick.n}\`));
  yield* Fake.Chat.subscribe("chat", fake, (message) => Effect.log(\`chat \${message.text}\`));
}) satisfies Ballast.Project;
`;

const writeBundle = async (
  projectsDir: string,
  projectName: string,
  content: string,
): Promise<string> => {
  const directory = join(projectsDir, projectSlug(projectName));
  await mkdir(join(directory, "artifacts", "dashboard"), { recursive: true });
  await writeFile(join(directory, "artifacts", "dashboard", "main.ts"), artifactEntry, "utf8");
  const file = join(directory, "ballast.ts");
  await writeFile(file, content, "utf8");
  return file;
};

const appReady = async (page: Page): Promise<void> => {
  await expect(page.locator("#boot")).toHaveCount(0);
  await expect(page.getByTestId("app-shell")).toBeVisible();
};

const applyTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await page.evaluate((value) => {
    localStorage.setItem("ballast.theme", value);
  }, theme);
  await page.reload();
  await appReady(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme))
    .toBe(theme);
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

const createProject = async (page: Page, name: string): Promise<void> => {
  await goHome(page);
  await page.getByTestId("new-project").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("create-project-name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
};

const openProject = async (page: Page, name: string): Promise<void> => {
  await goHome(page);
  const row = page.getByTestId("project-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
};

const unit = (page: Page, name: string) =>
  page.locator(`[data-testid="outline-row"][data-unit-name="${name}"]`);

/** The outline starts collapsed; its open state then persists per project. */
const openOutline = async (page: Page): Promise<void> => {
  const panel = page.getByTestId("outline-panel");
  await expect(panel).toBeVisible();
  if ((await panel.getAttribute("data-open")) !== "true") {
    await page.getByTestId("outline-toggle").click();
  }
  await expect(panel).toHaveAttribute("data-open", "true");
};

const obsRequirement = (page: Page) =>
  page.locator(
    '[data-testid="project-requirement"][data-integration="obs"][data-slot="main"]',
  );

const proposedHint = (page: Page) =>
  obsRequirement(page).getByText("Proposed · confirmed on Start");

const fillObsForm = async (
  page: Page,
  label: string,
  url: string,
): Promise<void> => {
  await goConnections(page);
  await page.getByTestId("add-connection").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("connection-integration").selectOption("obs");
  await page.getByTestId("connection-label").fill(label);
  await page.getByTestId("connection-field-url").fill(url);
};

const submitObsForm = async (page: Page, label: string): Promise<string> => {
  await page.getByTestId("create-connection-submit").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(label);
  await expect(dialog.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await dialog.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("connection-row").filter({ hasText: label });
  await expect(row).toBeVisible();
  const id = await row.getAttribute("data-connection-id");
  if (id === null) throw new Error("OBS connection row has no id");
  return id;
};

test("real service: connection instances, project bindings, workers, logs, source and failures", async ({
  page,
}) => {
  test.slow();
  const info = readRealServiceInfo();
  test.skip(info === undefined, "real service was not started by globalSetup");
  if (info === undefined) return;
  const obs = await startMockObsServer({ scenes: ["Game", "BRB", "Starting Soon"] });

  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  let artifactRenewals = 0;
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/rpc")) return;
    socket.on("framesent", (frame) => {
      const payload =
        typeof frame.payload === "string"
          ? frame.payload
          : frame.payload.toString("utf8");
      if (payload.includes("RenewArtifactView")) artifactRenewals += 1;
    });
  });

  try {
    await page.goto(`${info.url}/?token=${encodeURIComponent(info.token)}`);
    await page.evaluate(() => localStorage.setItem("ballast.theme", "dark"));
    await page.reload();
    await appReady(page);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    // ListIntegrations drives the catalog; the fixed callback port supplies Twitch's redirect URL.
    await goConnections(page);
    await page.getByTestId("add-connection").click();
    const catalogDialog = page.getByRole("dialog");
    await expect(catalogDialog.getByTestId("connection-integration")).toContainText("OBS Studio");
    await catalogDialog.getByTestId("connection-integration").selectOption("twitch");
    await expect(catalogDialog).toContainText("http://localhost:43123/callback");
    await expect(catalogDialog.getByTestId("connection-redirect-copy")).toBeVisible();
    await catalogDialog.getByRole("button", { name: "Close" }).click();

    // A service-level OBS instance exists before any project.
    await fillObsForm(page, "Studio OBS", obs.url);
    const studioId = await submitObsForm(page, "Studio OBS");

    const mainName = "E2E Project";
    await createProject(page, mainName);
    await writeBundle(info.projectsDir, mainName, projectBundle(mainName));
    await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-open", "true");
    await openOutline(page);
    await expect(unit(page, "alpha")).toBeVisible({ timeout: 20_000 });
    await expect(unit(page, "beta")).toBeVisible();
    await expect(unit(page, "cooldown")).toBeVisible();
    const requirement = obsRequirement(page);
    await expect(requirement).toBeVisible();
    await expect(requirement.getByText("Proposed · confirmed on Start")).toBeVisible();
    await expect(requirement).toHaveAttribute("data-bound-instance", studioId);

    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await expect(page.getByRole("heading", { name: mainName })).toBeVisible();
      await expect(proposedHint(page)).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(150);
      await page.screenshot({
        path: `screenshots/real-${theme}-10-project-connections.png`,
      });
    }

    // The project needs the user: Set up… leads to the consent review, which
    // also confirms the sole-instance proposal.
    await expect(page.getByTestId("project-status")).toHaveText("Needs you", { timeout: 20_000 });
    await expect(page.getByTestId("toggle-project")).toHaveText("Set up…");
    await page.getByTestId("toggle-project").click();
    await expect(page.getByTestId("project-consent")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("approve-project-consent")).toBeFocused();
    await expect(page.getByTestId("consent-binding")).toContainText("Studio OBS");
    await expect(page.getByTestId("consent-binding")).toContainText("OBS Studio · main");
    await expect(requirement).toHaveAttribute("data-bound-instance", studioId);

    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await expect(page.getByRole("heading", { name: mainName })).toBeVisible();
      await expect(page.getByTestId("project-consent")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-06-consent.png` });
    }
    await page.getByTestId("approve-project-consent").click();
    await expect(page.getByTestId("project-status")).toHaveText("Running", { timeout: 20_000 });
    await expect(page.getByTestId("toggle-project")).toHaveText("Stop");
    await expect(requirement.getByText("Proposed · confirmed on Start")).toHaveCount(0);
    await expect(
      page.getByTestId("log-line").filter({ hasText: "hello from alpha" }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Running project, unit-filtered logs and source jump in both themes.
    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await expect(page.getByRole("heading", { name: mainName })).toBeVisible();
      await openOutline(page);
      await expect(unit(page, "alpha")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from alpha" }).first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("timer-row").filter({ hasText: "demo" })).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-03-project.png` });

      // The real gateway serves a built artifact into the sandboxed iframe.
      await expect(page.getByTestId("artifact-row")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 20_000 },
      );
      await page.getByTestId("artifact-row").getByRole("button").first().click();
      await expect(page.getByTestId("artifact-panel")).toBeVisible();
      await expect(
        page.frameLocator("iframe").getByRole("heading", { name: "E2E artifact" }),
      ).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-11-artifact.png` });

      if (theme === "dark") {
        // Renewals must keep the same page and its in-page state: a reload
        // would reset this counter. The shortened service TTL makes the
        // viewer renew three times while this waits.
        const artifactFrame = page.frameLocator("iframe");
        const bump = artifactFrame.getByRole("button", { name: "Bump counter" });
        await bump.click();
        await bump.click();
        await bump.click();
        await expect(artifactFrame.getByTestId("artifact-counter")).toHaveText("3");
        const firstSrc = await page.locator("iframe").getAttribute("src");
        await expect
          .poll(() => artifactRenewals, { timeout: 15_000 })
          .toBeGreaterThanOrEqual(3);
        expect(await page.locator("iframe").getAttribute("src")).toBe(firstSrc);
        await expect(artifactFrame.getByTestId("artifact-counter")).toHaveText("3");

        await page.getByTestId("artifact-menu").click();
        await page.getByTestId("artifact-urls").click();
        await page.getByTestId("artifact-url-create").click();
        await expect(page.getByTestId("artifact-url-copy-value")).toContainText("/a/");
        const readCopy = await page.getByTestId("artifact-url-copy-value").textContent();
        expect(readCopy).toContain("http://127.0.0.1:");
        await page.getByTestId("artifact-url-scope").selectOption("action");
        await page.getByTestId("artifact-url-create").click();
        await expect(page.getByTestId("artifact-url-confirmation")).toBeVisible();
        await page
          .getByTestId("artifact-url-confirmation")
          .getByRole("button", { name: "Approve" })
          .click();
        await expect(page.getByTestId("artifact-url-copy-value")).toContainText("/a/");
        await expect(page.getByTestId("artifact-url-copy-value")).not.toHaveText(
          readCopy ?? "",
        );
        await expect(page.getByTestId("artifact-url-row")).toHaveCount(2);
        await page.getByTestId("artifact-url-row").first().getByTestId("artifact-url-revoke").click();
        await expect(page.getByTestId("artifact-url-row")).toHaveCount(1);
        await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
      }

      await expect(unit(page, "alpha")).toBeVisible();

      // Runs are not clickable; the code icon shows the declaration, and the
      // logs panel filters by unit.
      await expect(unit(page, "alpha")).toHaveAttribute("data-clickable", "false");
      await unit(page, "alpha").hover();
      await unit(page, "alpha").getByTestId("outline-source").click();
      await page.getByTestId("log-unit-filter").selectOption({ label: "Run · alpha" });
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from alpha" }).first(),
      ).toBeVisible();
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from beta" }),
      ).toHaveCount(0);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-05-logs-unit.png` });

      await expect(page.getByTestId("source-panel")).toContainText("OBS.Connection");
      await expect(page.locator('[data-highlighted="true"]')).toContainText("Ballast.run");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-04-source-jump.png` });
    }

    // A ~1000-line file paints as plain text at once and is highlighted soon after.
    await applyTheme(page, "dark");
    const bigLines: Array<string> = [];
    for (let index = 0; bigLines.length < 1_000; index += 1) {
      // Valid on its own, so the project keeps planning cleanly.
      bigLines.push(
        `// Block ${index}: generated to measure highlighting.`,
        `export const handler${index} = function* (): Generator<number, { index: number; label: string }> {`,
        `  yield* [${index}];`,
        `  return { index: ${index}, label: \`item \${${index} + 1}\` } satisfies { index: number; label: string };`,
        "};",
      );
    }
    await mkdir(join(info.projectsDir, projectSlug(mainName), "src"), { recursive: true });
    await writeFile(join(info.projectsDir, projectSlug(mainName), "src", "big.ts"), bigLines.join("\n") + "\n", "utf8");
    await page.getByTestId("source-panel").getByRole("button", { name: "Refresh source" }).click();
    const bigFile = page.locator('[data-testid="source-file"][data-path="src/big.ts"]');
    await expect(bigFile).toBeVisible({ timeout: 20_000 });
    const clickedAt = Date.now();
    await bigFile.click();
    await expect(page.locator('[data-line="1000"]')).toBeAttached({ timeout: 10_000 });
    const plainMs = Date.now() - clickedAt;
    const highlighted = page.locator('[data-testid="code-view"][data-highlight="tokens"]');
    await expect(highlighted).toHaveAttribute("data-highlight-ms", /\d+/, { timeout: 10_000 });
    const highlightMs = Number(await highlighted.getAttribute("data-highlight-ms"));
    test.info().annotations.push({
      type: "source-paint",
      description: `1000 lines: plain ${plainMs}ms after click, highlighted ${highlightMs}ms after load`,
    });
    console.log(`[source-paint] 1000 lines: plain ${plainMs}ms after click, highlighted ${highlightMs}ms after load`);
    expect(highlightMs).toBeLessThan(3_000);
    await page.locator('[data-testid="source-file"][data-path="ballast.ts"]').click();

    // Add a second OBS instance and capture the add form in both themes.
    await applyTheme(page, "light");
    await fillObsForm(page, "Backup OBS", obs.url);
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-light-09-add-connection.png" });
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await applyTheme(page, "dark");
    await fillObsForm(page, "Backup OBS", obs.url);
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-dark-09-add-connection.png" });
    const backupId = await submitObsForm(page, "Backup OBS");

    // The project picker now offers both compatible OBS instances.
    await openProject(page, mainName);
    const picker = obsRequirement(page).getByTestId("project-connection-picker");
    await expect(picker).toHaveValue(studioId);

    // Rebinding a running project warns and restarts it.
    await picker.selectOption(backupId);
    await expect(page.getByRole("dialog")).toContainText("restart");
    await page.getByRole("dialog").getByRole("button", { name: "Rebind" }).click();
    await expect(obsRequirement(page)).toHaveAttribute("data-bound-instance", backupId, {
      timeout: 20_000,
    });
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // The UI explains the bound instance cannot be deleted; the service refuses it.
    await goConnections(page);
    const backupRow = page
      .getByTestId("connection-row")
      .filter({ hasText: "Backup OBS" });
    await expect(backupRow).toContainText("unbind before deleting");
    await expect(
      backupRow.getByRole("button", {
        name: "Unbind this connection from its projects before deleting",
      }),
    ).toBeDisabled();

    const rpc = new URL("/rpc", info.url);
    rpc.protocol = rpc.protocol === "https:" ? "wss:" : "ws:";
    rpc.searchParams.set("token", info.token);
    const runtime = await createAgentRuntime({
      kind: "websocket",
      label: "e2e assertions",
      rpcUrl: rpc.toString(),
      token: info.token,
    });
    let refused = false;
    try {
      await runtime.run(runtime.client.DeleteConnection({ id: backupId }));
    } catch {
      refused = true;
    } finally {
      await runtime.dispose();
    }
    expect(refused).toBe(true);

    // With two OBS instances there is no proposal, so a new project needs connections.
    const needsName = "E2E Needs";
    await createProject(page, needsName);
    await writeBundle(info.projectsDir, needsName, projectBundle(needsName));
    await goHome(page);
    const needsRow = page.getByTestId("project-row").filter({ hasText: needsName });
    await expect(needsRow).toHaveAttribute("data-status", "needs-user", {
      timeout: 20_000,
    });
    await expect(needsRow.getByTestId("project-status-word")).toHaveText("Needs you");
    await expect(needsRow.getByTestId("project-action")).toHaveText("Set up…");

    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await goHome(page);
      await expect(page.getByTestId("project-row").first()).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-01-projects.png` });

      await page.getByTestId("new-project").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-02-new-project.png` });
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

      await goConnections(page);
      await expect(page.getByTestId("connection-row").first()).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-08-connections.png` });
    }

    // A failed change keeps the worker running; the status popover lists it and
    // the source pane marks its line. There is no banner.
    await applyTheme(page, "dark");
    await openProject(page, mainName);
    await writeBundle(info.projectsDir, mainName, brokenBundle());
    const changeIssue = page.locator('[data-testid="project-issue"][data-issue-kind="change-not-applied"]');
    await expect(page.getByTestId("project-status")).toHaveAttribute("data-issues", /[1-9]/, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("project-status")).toHaveText("Running");
    await expect(page.getByTestId("toggle-project")).toHaveText("Stop");
    await expect(page.getByTestId("restart-project")).toBeVisible();
    await expect(page.getByText(/previous version/i)).toHaveCount(0);
    await expect(page.getByTestId("project-error")).toHaveCount(0);
    await page.getByTestId("project-status").click();
    await expect(changeIssue).toBeVisible();
    await expect(changeIssue).toContainText("TS2322");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-dark-07-reload-failed.png" });
    await changeIssue.click();
    await expect(page.locator('[data-highlighted="true"]')).toContainText("broken");
    await expect(page.locator('[data-line="4"]')).toHaveAttribute("data-marked", "true");
    await expect(page.getByTestId("source-marker")).toHaveAttribute("aria-label", /TS2322/);

    await applyTheme(page, "light");
    await expect(page.getByTestId("source-marker")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("toggle-project")).toHaveText("Stop");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-light-07-reload-failed.png" });

    await writeBundle(info.projectsDir, mainName, projectBundle(mainName));
    await expect(page.getByTestId("source-marker")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("project-status")).toHaveText("Running", { timeout: 30_000 });

    // Cancelling a timer and editing project-level params both round-trip.
    const timer = page.getByTestId("timer-row").filter({ hasText: "demo" });
    await expect(timer).toBeVisible({ timeout: 20_000 });
    await timer.getByTestId("timer-cancel").click();
    await expect(timer).toHaveCount(0, { timeout: 10_000 });

    const greeting = page.getByTestId("project-param-greeting");
    await greeting.fill("hi");
    await greeting.press("Enter");
    await expect(greeting).toHaveValue("hi");

    const brbScene = page.locator(
      '[data-testid="project-param-option-scenes"][data-option="BRB"]',
    );
    await expect(brbScene).toBeChecked({ timeout: 20_000 });
    await brbScene.uncheck();
    await expect(brbScene).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.locator('[data-testid="project-param-option-scenes"][data-option="Game"]'),
    ).toBeChecked();

    expect(errors).toEqual([]);
  } finally {
    await obs.close();
  }
});

test("real service: a topic tab lists the events a running project records", async ({ page }) => {
  test.slow();
  const info = readRealServiceInfo();
  test.skip(info === undefined, "real service was not started by globalSetup");
  if (info === undefined) return;
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${info.url}/?token=${encodeURIComponent(info.token)}`);
  await page.evaluate(() => localStorage.setItem("ballast.theme", "dark"));
  await page.reload();
  await appReady(page);

  // A fake connection: its local driver emits a tick a second and a chat
  // message every few seconds.
  await goConnections(page);
  await page.getByTestId("add-connection").click();
  await page.getByTestId("connection-integration").selectOption("fake");
  await page.getByTestId("connection-label").fill("E2E Fake");
  await page.getByTestId("create-connection-submit").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Done" }).click();

  const name = "E2E Ticks";
  await createProject(page, name);
  await writeBundle(info.projectsDir, name, tickBundle(name));
  const tick = unit(page, "tick");
  await expect(tick).toBeVisible({ timeout: 20_000 });

  // Set up (consent for the proposed binding) or Start, then wait for ticks.
  const action = page.getByTestId("toggle-project");
  await expect(action).toHaveText(/Set up…|Start/, { timeout: 20_000 });
  if ((await action.textContent())?.includes("Set up") === true) {
    await action.click();
    await expect(page.getByTestId("approve-project-consent")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("approve-project-consent").click();
  } else {
    await action.click();
  }
  await expect(page.getByTestId("project-status")).toHaveText("Running", { timeout: 20_000 });

  await tick.getByRole("button").first().click();
  const view = page.getByTestId("topic-events");
  await expect(view).toHaveAttribute("data-state", "off", { timeout: 20_000 });
  await expect(page.getByTestId("topic-events-off")).toContainText("History is off for this topic");

  await unit(page, "chat").getByRole("button").first().click();
  await expect(view).toHaveAttribute("data-topic", "chat");
  await expect(view).toHaveAttribute("data-state", "on", { timeout: 20_000 });
  const rows = page.getByTestId("topic-event");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  // New messages arrive while the tab is open.
  const seen = await rows.count();
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(seen);
  await rows.first().click();
  await expect(page.getByTestId("topic-event-json")).toContainText('"text"');
  await page.waitForTimeout(150);
  await page.screenshot({ path: "screenshots/real-dark-12-topic-events.png" });
  expect(errors).toEqual([]);
});
