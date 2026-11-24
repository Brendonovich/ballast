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
    await expect(page.getByTestId("outline-panel")).toHaveAttribute("data-open", "false");
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

    // Start confirms the sole-instance proposal and raises the consent review.
    await page.getByTestId("toggle-project").click();
    await expect(page.getByTestId("project-consent")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("consent-binding")).toContainText("Studio OBS");
    await expect(page.getByTestId("consent-binding")).toContainText("OBS Studio · main");
    await expect(requirement).toHaveAttribute("data-bound-instance", studioId);
    await expect(requirement.getByText("Proposed · confirmed on Start")).toHaveCount(0);

    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await expect(page.getByRole("heading", { name: mainName })).toBeVisible();
      await expect(page.getByTestId("project-consent")).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-06-consent.png` });
    }
    await page.getByTestId("approve-project-consent").click();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
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

      await page
        .getByTestId("artifact-panel")
        .getByRole("button", { name: "Back to source" })
        .click();
      await expect(unit(page, "alpha")).toBeVisible();

      // One click on an outline item filters its logs and shows its declaration.
      await unit(page, "alpha").click();
      await expect(unit(page, "alpha")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("log-unit-filter").locator("option:checked")).toHaveText(
        "Run · alpha",
      );
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
    await expect(needsRow).toHaveAttribute("data-status", "needs-connections", {
      timeout: 20_000,
    });
    await expect(needsRow.getByText("Needs connections")).toBeVisible();

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

    // A failed reload keeps the previous worker running and links the error line.
    await applyTheme(page, "dark");
    await openProject(page, mainName);
    await writeBundle(info.projectsDir, mainName, brokenBundle());
    await expect(page.getByTestId("project-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Running previous version, latest change failed")).toBeVisible();
    await expect(page.getByTestId("toggle-project")).toHaveText("Stop");
    await expect(page.getByTestId("restart-project")).toBeVisible();
    await expect(page.getByTestId("project-error")).toContainText("TS2322");
    await expect(page.getByTestId("project-error-source")).toHaveText("ballast.ts:4");
    await expect(page.getByTestId("project-error")).not.toContainText("ballast.ts:4:7");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-dark-07-reload-failed.png" });
    await page.getByTestId("project-error-source").click();
    await expect(page.locator('[data-highlighted="true"]')).toContainText("broken");

    await applyTheme(page, "light");
    await expect(page.getByTestId("project-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("toggle-project")).toHaveText("Stop");
    await page.waitForTimeout(150);
    await page.screenshot({ path: "screenshots/real-light-07-reload-failed.png" });

    await writeBundle(info.projectsDir, mainName, projectBundle(mainName));
    await expect(page.getByTestId("project-error")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

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
