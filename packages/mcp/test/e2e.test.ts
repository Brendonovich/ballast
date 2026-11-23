import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import * as Predicate from "effect/Predicate";
import * as McpClient from "effect/ai/McpClient";
import * as McpProtocol from "effect/ai/McpProtocol";
import type * as McpSchema from "effect/ai/McpSchema";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupService, mcpCommand, mcpRoot, startService } from "./support/process.ts";
import type { RunningService } from "./support/process.ts";

let service: RunningService | undefined;

beforeAll(async () => {
  service = await startService();
});

afterAll(async () => {
  if (service !== undefined) await cleanupService(service);
});

const clientLayer = (env: Readonly<Record<string, string | undefined>>) =>
  McpClient.layerStdio({
    name: "ballast-mcp-test",
    version: "0.0.0",
    command: ChildProcess.make(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        ...mcpCommand,
      ],
      { cwd: mcpRoot, env },
    ),
    protocol: McpProtocol.v2025_11_25,
    timeout: "20 seconds",
  });

const withClient = <A>(
  env: Readonly<Record<string, string | undefined>>,
  use: (client: McpClient.McpClient) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* use(yield* McpClient.McpClient);
      }).pipe(
        Effect.provide(clientLayer(env)),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );

const textOf = (result: McpSchema.CallToolResult): string => {
  const parts: Array<string> = [];
  for (const part of result.content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
};

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isReadonlyObject(value) ? value : undefined;

const stringOf = (record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const numberField = (record: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
};

const call = (
  client: McpClient.McpClient,
  tools: ReadonlyArray<McpSchema.Tool>,
  name: string,
  args: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error("Missing tool " + name);
    return yield* client.callTool({ tool, arguments: args });
  });

describe("real MCP stdio client against a real Ballast service", () => {
  it("lists the tools and gets real catalog, check, apply and status output", async () => {
    if (service === undefined) throw new Error("Service did not start");
    const root = service.root;
    const env = {
      ...process.env,
      BALLAST_STATE_DIR: service.stateDir,
      BALLAST_DATA_DIR: service.dataDir,
    };
    const projectDir = join(root, "project");

    await withClient(env, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([
          "ballast_guide",
          "ballast_catalog",
          "ballast_project_init",
          "ballast_check",
          "ballast_apply",
          "ballast_status",
          "ballast_logs",
          "ballast_events",
        ]);

        const catalog = yield* call(client, tools, "ballast_catalog", {
          integration: "fake",
          includeSchemas: true,
        });
        const catalogText = textOf(catalog);
        expect(catalogText).toContain("fake/tick");
        expect(catalogText).toContain("schema:");
        expect(catalog.isError).not.toBe(true);

        const filtered = yield* call(client, tools, "ballast_catalog", {
          integration: "obs",
          request: "SetCurrentProgramScene",
        });
        expect(textOf(filtered)).toContain("obs/SetCurrentProgramScene");
        expect(textOf(filtered)).not.toContain("CreateScene");

        const paged = yield* call(client, tools, "ballast_catalog", {
          integration: "obs",
          kind: "requests",
          limit: 2,
        });
        expect(textOf(paged)).toContain("truncated");
        const pagedData = recordOf(paged.structuredContent);
        const pages = pagedData?.["pages"];
        expect(Array.isArray(pages)).toBe(true);
        if (Array.isArray(pages)) {
          const page = recordOf(pages[0]);
          expect(numberField(page, "requestNextOffset")).toBe(2);
        }

        const invalid = yield* call(client, tools, "ballast_catalog", {
          integration: "obs",
          request: "SetCurrentProgramScene",
          bogus: true,
        });
        expect(invalid.isError).toBe(true);
        expect(textOf(invalid)).toContain("Invalid arguments");

        const init = yield* call(client, tools, "ballast_project_init", {
          dir: projectDir,
          name: "E2E Project",
        });
        const initData = recordOf(init.structuredContent);
        const project = recordOf(initData?.["project"]);
        const projectId = stringOf(project, "id");
        expect(projectId).toBeDefined();
        expect(stringOf(project, "name")).toBe("E2E Project");
        expect(stringOf(project, "entry")).toBe("ballast.ts");

        const check = yield* call(client, tools, "ballast_check", { project: "E2E Project" });
        const checkData = recordOf(check.structuredContent);
        expect(checkData?.["ok"]).toBe(true);
        const units = checkData?.["units"];
        expect(Array.isArray(units)).toBe(true);
        if (!Array.isArray(units)) throw new Error("check units are not an array");
        expect(units.length).toBeGreaterThanOrEqual(1);
        const sourceFiles: Array<string> = [];
        for (const unit of units) {
          const record = recordOf(unit);
          const source = recordOf(record?.["source"]);
          const file = stringOf(source, "file");
          if (file !== undefined) {
            expect(file.startsWith("..")).toBe(false);
            expect(file.startsWith("/")).toBe(false);
            sourceFiles.push(file);
          }
        }
        expect(sourceFiles.length).toBeGreaterThan(0);
        expect(sourceFiles.every((file) => file === "ballast.ts")).toBe(true);
        expect(checkData?.["diagnostics"]).toEqual([]);

        const requirementDir = join(root, "requirements");
        yield* call(client, tools, "ballast_project_init", {
          dir: requirementDir,
          name: "E2E Requirements",
        });
        yield* Effect.promise(() =>
          writeFile(
            join(requirementDir, "ballast.ts"),
            [
              'import * as Fake from "@ballast/fake";',
              'import { Effect } from "effect";',
              "",
              "export default Effect.gen(function* () {",
              '  const fake = yield* Fake.Connection("main");',
              '  yield* Fake.Tick.subscribe("tick", fake, () => Effect.void);',
              "});",
              "",
            ].join("\n"),
            "utf8",
          ),
        );
        const requirementCheck = yield* call(client, tools, "ballast_check", {
          project: "E2E Requirements",
        });
        const requirementData = recordOf(requirementCheck.structuredContent);
        expect(requirementData?.["ok"]).toBe(true);
        expect(textOf(requirementCheck)).toContain("fake/main");
        expect(textOf(requirementCheck)).toContain(
          "none: user must add a fake connection in the Ballast app",
        );
        const requirementApply = yield* call(client, tools, "ballast_apply", {
          project: "E2E Requirements",
        });
        const requirementApplyData = recordOf(requirementApply.structuredContent);
        expect(requirementApplyData?.["state"]).toBe("waiting_for_user");
        expect(requirementApplyData?.["reason"]).toBe("connections");
        expect(textOf(requirementApply)).toContain("fake/main");

        yield* Effect.promise(() =>
          writeFile(
            join(projectDir, "ballast.ts"),
            [
              'import { Effect } from "effect";',
              "",
              "const wrong: string = 42;",
              "",
              "export default Effect.gen(function* () {",
              "  yield* Effect.log(wrong);",
              "});",
              "",
            ].join("\n"),
            "utf8",
          ),
        );

        const bad = yield* call(client, tools, "ballast_check", { project: "E2E Project" });
        const badData = recordOf(bad.structuredContent);
        expect(badData?.["ok"]).toBe(false);
        const diagnostics = badData?.["diagnostics"];
        expect(Array.isArray(diagnostics)).toBe(true);
        if (!Array.isArray(diagnostics)) throw new Error("diagnostics are not an array");
        const first = recordOf(diagnostics[0]);
        expect(stringOf(first, "file")).toBe("ballast.ts");
        expect(numberField(first, "line")).toBe(3);
        expect(stringOf(first, "code")).toBe("TS2322");
        expect(textOf(bad)).toContain("ballast.ts:3:");

        // Restore the scaffold so the remaining calls exercise the good path.
        yield* Effect.promise(() =>
          writeFile(
            join(projectDir, "ballast.ts"),
            [
              'import * as Ballast from "@ballast/core";',
              'import { Effect } from "effect";',
              "",
              "export default Effect.gen(function* () {",
              '  const message = yield* Ballast.Param.string("message", { default: "ok" });',
              '  yield* Ballast.run("log", Effect.gen(function* () {',
              "    yield* Effect.log(yield* message);",
              "  }));",
              "});",
              "",
            ].join("\n"),
            "utf8",
          ),
        );

        const apply = yield* call(client, tools, "ballast_apply", { project: "E2E Project" });
        const applyData = recordOf(apply.structuredContent);
        expect(applyData?.["state"]).toBe("waiting_for_user");
        expect(applyData?.["reason"]).toBe("start");

        const status = yield* call(client, tools, "ballast_status", { project: "E2E Project" });
        const statusData = recordOf(status.structuredContent);
        expect(statusData?.["state"]).toBe("stopped");

        const logs = yield* call(client, tools, "ballast_logs", { project: "E2E Project" });
        expect(Array.isArray(recordOf(logs.structuredContent)?.["logs"])).toBe(true);

        const events = yield* call(client, tools, "ballast_events", { project: "E2E Project" });
        expect(Array.isArray(recordOf(events.structuredContent)?.["events"])).toBe(true);
      }),
    );
  }, 120_000);

  it("returns a clear tool error when Ballast is not running", async () => {
    const empty = join(service?.root ?? "/tmp", "empty-state");
    const env = {
      ...process.env,
      BALLAST_STATE_DIR: empty,
      BALLAST_DATA_DIR: join(service?.root ?? "/tmp", "empty-data"),
    };
    await withClient(env, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools();
        const status = yield* call(client, tools, "ballast_status", {});
        expect(status.isError).toBe(true);
        expect(textOf(status)).toContain("Ballast is not running");
      }),
    );
  }, 60_000);
});
