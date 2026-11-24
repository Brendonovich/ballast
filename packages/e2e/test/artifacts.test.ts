import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { startService } from "./support/process.ts";
import { withAgentClient } from "./support/rpc.ts";

const example = fileURLToPath(
  new URL("../../../examples/stream-dashboard", import.meta.url),
);

describe("stream dashboard artifact", () => {
  it(
    "serves the example dashboard, updates counters and resets them",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ballast-stream-dashboard-"));
      const project = join(root, "project");
      await cp(example, project, { recursive: true });
      await rm(join(project, ".ballast"), { recursive: true, force: true });
      const service = await startService({
        root: join(root, "service"),
        cloudUrl: "http://127.0.0.1:9",
      });
      const browser = await chromium.launch({ headless: true });
      try {
        const { projectId, pageUrl } = await withAgentClient(
          service.registration,
          (client) =>
            Effect.gen(function* () {
              const connection = yield* client.CreateConnection({
                integration: "fake",
                label: "E2E Fake",
                config: {},
              });
              const added = yield* client.AddProject({
                path: project,
                name: "Stream dashboard",
              });
              const addError = added.summary.issues.find(
                (issue) => issue.severity === "error",
              );
              if (addError !== undefined) {
                return yield* Effect.fail(new Error(addError.detail ?? addError.title));
              }
              const id = added.summary.id;
              yield* client.SetProjectBinding({
                projectId: id,
                integration: "fake",
                slot: "main",
                instanceId: connection.id,
              });
              yield* client.StartProject({ projectId: id });
              let consentId: string | undefined;
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const listed = yield* client.ListProjectConsents({ projectId: id });
                consentId = listed.consents[0]?.id;
                if (consentId !== undefined) break;
                yield* Effect.sleep("100 millis");
              }
              if (consentId === undefined) {
                const detail = yield* client.GetProject({ projectId: id });
                return yield* Effect.fail(
                  new Error("No project consent appeared: " + JSON.stringify(detail.summary)),
                );
              }
              yield* client.ApproveProjectConsent({ consentId });
              yield* client.StartProject({ projectId: id });
              const view = yield* client.GetArtifactView({
                projectId: id,
                artifact: "dashboard",
              });
              return { projectId: id, pageUrl: view.pageUrl };
            }),
        );
        expect(projectId.length).toBeGreaterThan(0);
        const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
        const errors: Array<string> = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Stream dashboard" }).waitFor();
        await page.locator("strong").first().waitFor();
        await page.waitForFunction(
          () => {
            const element = document.querySelector("strong");
            return element !== null && (element.textContent ?? "") !== "0";
          },
          undefined,
          { timeout: 30_000 },
        );
        await page.getByRole("button", { name: "Reset counters" }).click();
        await page.waitForFunction(
          () => {
            const values = [...document.querySelectorAll("strong")].map(
              (element) => element.textContent,
            );
            return values.length === 2 && values.every((value) => value === "0");
          },
          undefined,
          { timeout: 20_000, polling: 10 },
        );
        if (errors.length > 0) throw new Error("browser errors: " + errors.join(" | "));
      } finally {
        await browser.close();
        await service.process.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
