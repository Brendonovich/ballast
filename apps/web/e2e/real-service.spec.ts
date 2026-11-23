import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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

const writeBundle = async (
  projectsDir: string,
  projectName: string,
  content: string,
): Promise<string> => {
  const file = join(projectsDir, projectSlug(projectName), "ballast.ts");
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

const createProject = async (page: Page, name: string): Promise<void> => {
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("new-project").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("create-project-name").fill(name);
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
};

const openProject = async (page: Page, name: string): Promise<void> => {
  await page.getByTestId("nav-projects").click();
  const row = page.getByTestId("project-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
};

const unit = (page: Page, name: string) =>
  page.locator(`[data-testid="unit-row"][data-unit-name="${name}"]`);

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
  await page.getByTestId("nav-connections").click();
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

  try {
    await page.goto(`${info.url}/?token=${encodeURIComponent(info.token)}`);
    await page.evaluate(() => localStorage.setItem("ballast.theme", "dark"));
    await page.reload();
    await appReady(page);
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    // A service-level OBS instance exists before any project.
    await fillObsForm(page, "Studio OBS", obs.url);
    const studioId = await submitObsForm(page, "Studio OBS");

    const mainName = "E2E Project";
    await createProject(page, mainName);
    await writeBundle(info.projectsDir, mainName, projectBundle(mainName));
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
      await expect(unit(page, "alpha")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from alpha" }).first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("timer-row").filter({ hasText: "demo" })).toBeVisible({
        timeout: 20_000,
      });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-03-project.png` });

      await unit(page, "alpha").getByRole("button").first().click();
      await expect(page.getByTestId("log-unit-filter")).toContainText("alpha");
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from alpha" }).first(),
      ).toBeVisible();
      await expect(
        page.getByTestId("log-line").filter({ hasText: "hello from beta" }),
      ).toHaveCount(0);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-05-logs-unit.png` });

      await unit(page, "alpha").getByTestId("unit-source").click();
      await expect(page.getByTestId("source-panel")).toContainText("OBS.Connection");
      await expect(page.locator('[data-highlighted="true"]')).toContainText("Ballast.run");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-04-source-jump.png` });
    }

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
    await page.getByTestId("nav-connections").click();
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
    await page.getByTestId("nav-projects").click();
    const needsRow = page.getByTestId("project-row").filter({ hasText: needsName });
    await expect(needsRow).toHaveAttribute("data-status", "needs-connections", {
      timeout: 20_000,
    });
    await expect(needsRow.getByText("Needs connections")).toBeVisible();

    for (const theme of ["dark", "light"] as const) {
      await applyTheme(page, theme);
      await page.getByTestId("nav-projects").click();
      await expect(page.getByTestId("project-row").first()).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-01-projects.png` });

      await page.getByTestId("new-project").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `screenshots/real-${theme}-02-new-project.png` });
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

      await page.getByTestId("nav-connections").click();
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
    await brbScene.uncheck();
    await expect(brbScene).not.toBeChecked();
    await brbScene.check();
    await expect(brbScene).toBeChecked();

    expect(errors).toEqual([]);
  } finally {
    await obs.close();
  }
});
