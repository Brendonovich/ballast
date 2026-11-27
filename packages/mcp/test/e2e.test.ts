import { mkdir, writeFile } from "node:fs/promises";
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
          "ballast_share",
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
        expect(textOf(init)).toContain("tsconfig.json");
        const initFiles = initData?.["files"];
        expect(Array.isArray(initFiles)).toBe(true);
        if (!Array.isArray(initFiles)) throw new Error("init files are not an array");
        expect(initFiles).toContain("tsconfig.json");

        const check = yield* call(client, tools, "ballast_check", {
          project: "E2E Project",
          detail: "full",
        });
        const checkData = recordOf(check.structuredContent);
        expect(checkData?.["ok"]).toBe(true);
        expect(checkData?.["detail"]).toBe("full");
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

        // The folder name resolves too, and compact is the default shape.
        const compact = yield* call(client, tools, "ballast_check", { project: "project" });
        const compactData = recordOf(compact.structuredContent);
        expect(compactData?.["ok"]).toBe(true);
        expect(compactData?.["detail"]).toBe("compact");
        expect(compactData?.["manifest"]).toBeUndefined();
        expect(compactData?.["appliedManifest"]).toBeUndefined();
        expect(compactData?.["availableConnections"]).toBeUndefined();
        expect(compactData?.["units"]).toBeUndefined();
        expect(recordOf(compactData?.["snapshot"])?.["serviceStatus"]).toBe("stopped");
        expect(textOf(compact)).toContain("service status at check: stopped");
        expect(textOf(compact)).not.toContain("units:");

        // An absolute project root also resolves.
        const byRoot = yield* call(client, tools, "ballast_check", { project: projectDir });
        expect(recordOf(byRoot.structuredContent)?.["ok"]).toBe(true);

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
        expect(textOf(requirementCheck)).toContain("needs fake:read");
        const requirementApply = yield* call(client, tools, "ballast_apply", {
          project: "E2E Requirements",
        });
        const requirementApplyData = recordOf(requirementApply.structuredContent);
        expect(requirementApplyData?.["state"]).toBe("waiting_for_user");
        expect(requirementApplyData?.["reason"]).toBe("connections");
        expect(textOf(requirementApply)).toContain("fake/main");
        // A waiting outcome includes the compact check that explains it, but
        // never the full check payload.
        const applyCheck = recordOf(requirementApplyData?.["check"]);
        expect(applyCheck?.["detail"]).toBe("compact");
        expect(applyCheck?.["manifest"]).toBeUndefined();
        expect(applyCheck?.["appliedManifest"]).toBeUndefined();
        expect(recordOf(applyCheck?.["snapshot"])?.["serviceStatus"]).toBeDefined();
        expect(recordOf(requirementApplyData?.["project"])?.["issues"]).toBeUndefined();

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

  it("scaffolds the Solid artifact template and reports artifact status", async () => {
    if (service === undefined) throw new Error("Service did not start");
    const env = {
      ...process.env,
      BALLAST_STATE_DIR: service.stateDir,
      BALLAST_DATA_DIR: service.dataDir,
    };
    const projectDir = join(service.root, "artifact-project");
    await withClient(env, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools();
        const init = yield* call(client, tools, "ballast_project_init", {
          name: "E2E Artifact",
          dir: projectDir,
          artifact: true,
        });
        expect(textOf(init)).toContain("artifacts/dashboard/main.tsx");
        expect(textOf(init)).toContain("src/api.ts");
        const check = yield* call(client, tools, "ballast_check", {
          project: "E2E Artifact",
        });
        const checkData = recordOf(check.structuredContent);
        expect(checkData?.["ok"]).toBe(true);
        const artifacts = checkData?.["artifacts"];
        expect(Array.isArray(artifacts)).toBe(true);
        if (!Array.isArray(artifacts)) throw new Error("artifacts are not an array");
        expect(artifacts.length).toBe(1);
        const declarations = checkData?.["declarations"];
        expect(Array.isArray(declarations)).toBe(true);
        if (!Array.isArray(declarations)) throw new Error("declarations are not an array");
        expect(declarations.some((entry) => recordOf(entry)?.["kind"] === "artifact")).toBe(true);
        expect(declarations.some((entry) => recordOf(entry)?.["kind"] === "api")).toBe(true);
        expect(declarations.some((entry) => recordOf(entry)?.["kind"] === "store")).toBe(true);
        expect(textOf(check)).toContain("artifacts, api and stores:");
        expect(textOf(check)).toContain("reload:");

        const status = yield* call(client, tools, "ballast_status", {
          project: "E2E Artifact",
        });
        const statusData = recordOf(status.structuredContent);
        const statusArtifacts = statusData?.["artifacts"];
        expect(Array.isArray(statusArtifacts)).toBe(true);
        if (!Array.isArray(statusArtifacts)) throw new Error("status artifacts are not an array");
        expect(statusArtifacts.length).toBe(1);
        expect(textOf(status)).toContain("artifacts:");

        yield* Effect.promise(() =>
          writeFile(
            join(projectDir, "artifacts/dashboard/main.tsx"),
            'export const bad: number = document.title;\n',
            "utf8",
          ),
        );
        const badArtifact = yield* call(client, tools, "ballast_check", {
          project: "E2E Artifact",
        });
        const badArtifactData = recordOf(badArtifact.structuredContent);
        expect(badArtifactData?.["ok"]).toBe(false);
        const artifactDiagnostics = badArtifactData?.["diagnostics"];
        expect(Array.isArray(artifactDiagnostics)).toBe(true);
        if (!Array.isArray(artifactDiagnostics)) throw new Error("artifact diagnostics are not an array");
        const artifactDiagnostic = recordOf(artifactDiagnostics[0]);
        expect(stringOf(artifactDiagnostic, "file")).toBe("artifacts/dashboard/main.tsx");
        expect(numberField(artifactDiagnostic, "line")).toBe(1);
        expect(stringOf(artifactDiagnostic, "code")).toBe("TS2322");
        expect(textOf(badArtifact)).toContain("[artifact] artifacts/dashboard/main.tsx:1");
      }),
    );
  }, 120_000);

  it("reads durable subscription history through QueryEventHistory", async () => {
    if (service === undefined) throw new Error("Service did not start");
    const env = {
      ...process.env,
      BALLAST_STATE_DIR: service.stateDir,
      BALLAST_DATA_DIR: service.dataDir,
    };
    const projectDir = join(service.root, "history-project");
    await withClient(env, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools();
        yield* call(client, tools, "ballast_project_init", {
          name: "E2E History",
          dir: projectDir,
        });
        yield* Effect.promise(() =>
          writeFile(
            join(projectDir, "ballast.ts"),
            [
              'import * as Fake from "@ballast/fake";',
              'import { Effect } from "effect";',
              "",
              "export default Effect.gen(function* () {",
              '  const fake = yield* Fake.Connection("main");',
              '  yield* Fake.Chat.subscribe("chat-log", fake, () => Effect.void, {',
              '    history: { maxEntries: 100, retention: "1 day" },',
              "  });",
              "});",
              "",
            ].join("\n"),
            "utf8",
          ),
        );
        yield* Effect.promise(async () => {
          await mkdir(join(projectDir, ".ballast", "history"), { recursive: true });
          await writeFile(
            join(projectDir, ".ballast", "history", "chat-log.jsonl"),
            JSON.stringify({
              cursor: "7",
              receivedAt: Date.now(),
              fingerprint: "fingerprint",
              event: { text: "durable hello" },
            }) + "\n",
            "utf8",
          );
        });
        // Let the service plan the new subscription and register its history.
        yield* Effect.sleep("2500 millis");
        const history = yield* call(client, tools, "ballast_events", {
          project: "E2E History",
          subscription: "chat-log",
        });
        expect(textOf(history)).toContain("durable hello");
        const historyData = recordOf(history.structuredContent);
        const historyEntries = historyData?.["history"];
        expect(Array.isArray(historyEntries)).toBe(true);
        if (!Array.isArray(historyEntries)) throw new Error("history is not an array");
        expect(historyEntries.length).toBe(1);
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
