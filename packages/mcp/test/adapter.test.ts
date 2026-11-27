import { relative } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { emptyProjectManifest } from "@ballast/agent-protocol";
import type {
  ProjectDetail,
  ProjectSummary,
} from "@ballast/agent-protocol";

import {
  applyProject,
  checkData,
  checkText,
  classifyDiagnostics,
  matchProjectReference,
} from "../src/adapter.ts";
import type { CheckResult, ProjectAdapter } from "../src/adapter.ts";
import { toolError } from "../src/errors.ts";
import { applyOutput, formatStatus } from "../src/tools.ts";

const project = (
  id: string,
  name: string,
  root: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary => ({
  id,
  name,
  root,
  entry: "ballast.ts",
  enabled: false,
  status: "stopped",
  unitCount: 0,
  createdAt: 0,
  updatedAt: 0,
  issues: [],
  ...overrides,
});

const chat = project(
  "proj_chat",
  "Chat Scenes",
  "/Users/me/ballast-projects/chat-scenes",
);
const other = project("proj_other", "Other", "/Users/me/other");
const projects = [chat, other];

const matched = (reference: string): string => {
  const match = matchProjectReference(projects, reference);
  return "project" in match ? match.project.id : "error: " + match.error;
};

const baseCheck = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  summary: chat,
  ok: true,
  diagnostics: [],
  units: [],
  changes: [],
  requiresConsent: false,
  requirements: [],
  missingConnections: [],
  missingScopes: [],
  availableConnections: [],
  ...overrides,
});

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  summary: chat,
  manifest: emptyProjectManifest(chat.id, "ballast.ts"),
  requirements: [],
  units: [],
  issues: [],
  ...overrides,
});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

describe("project resolution", () => {
  it("matches an id", () => {
    expect(matched("proj_chat")).toBe("proj_chat");
  });

  it("matches a display name case-insensitively", () => {
    expect(matched("Chat Scenes")).toBe("proj_chat");
    expect(matched("chat scenes")).toBe("proj_chat");
  });

  it("matches a full project root, with or without a trailing slash", () => {
    expect(matched(chat.root)).toBe("proj_chat");
    expect(matched(chat.root + "/")).toBe("proj_chat");
  });

  it("normalizes dot segments in a path", () => {
    expect(matched(chat.root + "/../chat-scenes")).toBe("proj_chat");
  });

  it("matches the project folder basename", () => {
    expect(matched("chat-scenes")).toBe("proj_chat");
  });

  it("matches a relative path from the current directory", () => {
    expect(matched(relative(process.cwd(), chat.root))).toBe("proj_chat");
  });

  it("matches a relative path by its trailing directories", () => {
    expect(matched("ballast-projects/chat-scenes")).toBe("proj_chat");
  });

  it("rejects an empty reference", () => {
    expect(matched("  ")).toContain("A project id, name or path is required");
  });

  it("lists every known project with its root on no match", () => {
    const result = matched("missing-project");
    expect(result).toContain("No Ballast project matches 'missing-project'");
    expect(result).toContain("proj_chat");
    expect(result).toContain("Chat Scenes");
    expect(result).toContain(chat.root);
    expect(result).toContain(other.root);
  });

  it("reports ambiguous display names with roots", () => {
    const duplicates = [
      project("proj_a", "Chat Scenes", "/Users/me/a/chat-scenes"),
      project("proj_b", "Chat Scenes", "/Users/me/b/chat-scenes"),
    ];
    const match = matchProjectReference(duplicates, "Chat Scenes");
    expect("error" in match ? match.error : "").toContain("ambiguous");
    expect("error" in match ? match.error : "").toContain("/Users/me/a/chat-scenes");
    expect("error" in match ? match.error : "").toContain("/Users/me/b/chat-scenes");
  });

  it("reports ambiguous folder basenames instead of guessing", () => {
    const duplicates = [
      project("proj_a", "A", "/Users/me/a/chat-scenes"),
      project("proj_b", "B", "/Users/me/b/chat-scenes"),
    ];
    const match = matchProjectReference(duplicates, "chat-scenes");
    expect("error" in match ? match.error : "").toContain("ambiguous");
    expect("error" in match ? match.error : "").toContain("proj_a");
    expect("error" in match ? match.error : "").toContain("proj_b");
  });
});

describe("diagnostic classification", () => {
  const worker = {
    file: "src/api.ts",
    line: 10,
    column: 5,
    code: "TS2305",
    message: "Module './api.ts' has no exported member 'Chat'.",
  };
  const cascading = {
    file: "artifacts/dashboard/main.tsx",
    line: 4,
    column: 10,
    code: "TS2305",
    message: "Module '../../src/api.ts' has no exported member 'Chat'.",
  };
  const independent = {
    file: "artifacts/dashboard/main.tsx",
    line: 9,
    column: 3,
    code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'.",
  };

  it("deduplicates identical diagnostics", () => {
    const diagnostics = classifyDiagnostics([worker, worker, independent]);
    expect(diagnostics).toHaveLength(2);
  });

  it("classifies artifact errors and marks a worker cascade", () => {
    const diagnostics = classifyDiagnostics([worker, cascading, independent]);
    expect(diagnostics[0]?.origin).toBe("worker");
    expect(diagnostics[1]?.origin).toBe("artifact");
    expect(diagnostics[1]?.downstreamOf).toEqual({
      file: "src/api.ts",
      line: 10,
      column: 5,
      code: "TS2305",
    });
    expect(diagnostics[2]?.downstreamOf).toBeUndefined();
  });
});

describe("compact check output", () => {
  const manifest = {
    ...emptyProjectManifest(chat.id, "ballast.ts"),
    artifacts: [
      {
        name: "dashboard",
        entry: "artifacts/dashboard/main.tsx",
        source: { file: "ballast.ts", line: 8, column: 10 },
      },
    ],
    api: {
      source: { file: "ballast.ts", line: 12, column: 10 },
      procedures: [{ name: "Snapshot", stream: false }],
    },
  };
  const check = baseCheck({
    ok: false,
    manifest,
    appliedManifest: emptyProjectManifest(chat.id, "ballast.ts"),
    availableConnections: [],
    changes: [
      {
        kind: "api",
        name: "api",
        change: "changed",
        before: { procedures: [] },
        after: { procedures: [{ name: "Snapshot" }] },
      },
    ],
    requiresConsent: true,
    missingConnections: [{ integration: "obs", slot: "main", location: "local" }],
    missingScopes: ["obs:read", "obs:read"],
    units: [{ kind: "run", name: "ready", status: "active" }],
    diagnostics: [
      {
        file: "src/api.ts",
        line: 10,
        column: 5,
        code: "TS2305",
        message: "Module './api.ts' has no exported member 'Chat'.",
      },
      {
        file: "src/api.ts",
        line: 10,
        column: 5,
        code: "TS2305",
        message: "Module './api.ts' has no exported member 'Chat'.",
      },
    ],
  });

  it("omits manifests, units and the connection inventory by default", () => {
    const data = checkData(check);
    expect(field(data, "detail")).toBe("compact");
    expect(field(data, "ok")).toBe(false);
    expect(field(data, "manifest")).toBeUndefined();
    expect(field(data, "appliedManifest")).toBeUndefined();
    expect(field(data, "availableConnections")).toBeUndefined();
    expect(field(data, "units")).toBeUndefined();
    expect(field(data, "summary")).toBeUndefined();
    expect(field(field(data, "snapshot"), "serviceStatus")).toBe("stopped");
    expect(field(data, "requiresConsent")).toBe(true);
    expect(field(data, "missingScopes")).toEqual(["obs:read"]);
    expect(field(field(data, "reload"), "mode")).toBe("worker-restart");
    const changes = field(field(data, "reload"), "changes");
    expect(Array.isArray(changes)).toBe(true);
    const firstChange = Array.isArray(changes) ? changes[0] : undefined;
    expect(field(firstChange, "kind")).toBe("api");
    expect(field(firstChange, "before")).toBeUndefined();
    expect(field(firstChange, "after")).toBeUndefined();
    expect(Array.isArray(field(data, "declarations"))).toBe(true);
    expect(Array.isArray(field(data, "diagnostics"))).toBe(true);
    expect((field(data, "diagnostics") as ReadonlyArray<unknown>).length).toBe(1);
  });

  it("keeps full payloads behind detail full", () => {
    const issue = {
      id: "unit-failed",
      kind: "unit-failed" as const,
      severity: "error" as const,
      title: "unit failed",
      at: 0,
    };
    const data = checkData(
      { ...check, summary: { ...chat, issues: [issue, issue] } },
      undefined,
      "full",
    );
    expect(field(data, "detail")).toBe("full");
    expect(field(data, "manifest")).toBe(manifest);
    expect(field(data, "appliedManifest")).toBeDefined();
    expect(Array.isArray(field(data, "availableConnections"))).toBe(true);
    expect(Array.isArray(field(data, "units"))).toBe(true);
    const issues = field(field(data, "summary"), "issues");
    expect(Array.isArray(issues) ? issues.length : -1).toBe(1);
  });

  it("prints a compact text summary without the unit listing", () => {
    const text = checkText(check, undefined, { detail: "compact" });
    expect(text).toContain("service status at check: stopped");
    expect(text).toContain("check: FAILED");
    expect(text).toContain("src/api.ts:10:5 TS2305");
    expect(text).not.toContain("units:");
    expect(text).toContain("reload: restarts worker");
  });

  it("labels cascading artifact diagnostics in text", () => {
    const text = checkText(
      baseCheck({
        diagnostics: [
          {
            file: "src/api.ts",
            line: 10,
            column: 5,
            code: "TS2305",
            message: "Module './api.ts' has no exported member 'Chat'.",
          },
          {
            file: "artifacts/dashboard/main.tsx",
            line: 4,
            column: 10,
            code: "TS2305",
            message: "Module '../../src/api.ts' has no exported member 'Chat'.",
          },
        ],
      }),
      undefined,
      { detail: "compact" },
    );
    expect(text).toContain(
      "[artifact] artifacts/dashboard/main.tsx:4:10 TS2305",
    );
    expect(text).toContain("[cascades from src/api.ts:10 TS2305]");
  });
});

const adapter = (
  check: CheckResult,
  projectDetail: ProjectDetail,
  restart: () => ProjectDetail,
): ProjectAdapter => ({
  listProjects: () => Effect.succeed([projectDetail.summary]),
  resolveProject: () => Effect.succeed(projectDetail.summary),
  getProject: () => Effect.succeed(projectDetail),
  createProject: () => Effect.succeed(projectDetail),
  listProjectFiles: () => Effect.succeed({ entry: "ballast.ts", files: [] }),
  checkProject: () => Effect.succeed(check),
  listArtifacts: () => Effect.succeed([]),
  restartProject: () => Effect.succeed(restart()),
  shareProject: () => Effect.fail(toolError("sharing is not used in these tests")),
  listConnections: () => Effect.succeed([]),
  health: () => Effect.fail(toolError("health is not used in these tests")),
  queryEventHistory: () => Effect.succeed({ entries: [] }),
  listEventHistorySubscriptions: () => Effect.succeed({ subscriptions: [] }),
  logs: () => Effect.succeed([]),
  events: () => Effect.succeed([]),
});

describe("apply output", () => {
  const running = { ...chat, enabled: true, status: "running" as const };

  it("drops the stale check after a successful reload", async () => {
    const runningDetail = detail({ summary: running, appliedAt: 1 });
    const outcome = await Effect.runPromise(
      applyProject(
        adapter(baseCheck(), runningDetail, () => runningDetail),
        running,
      ),
    );
    expect(outcome.state).toBe("running");
    expect(outcome.check).toBeUndefined();
    expect(outcome.project?.status).toBe("running");
  });

  it("returns state and a minimal project summary on success", async () => {
    const runningDetail = detail({ summary: running, appliedAt: 1 });
    const outcome = await Effect.runPromise(
      applyProject(
        adapter(baseCheck(), runningDetail, () => runningDetail),
        running,
      ),
    );
    const output = applyOutput(outcome);
    expect(field(output.data, "check")).toBeUndefined();
    expect(field(field(output.data, "project"), "status")).toBe("running");
    expect(field(field(output.data, "project"), "issues")).toBeUndefined();
    expect(output.text).toContain("status running");
    expect(output.text).not.toContain("check:");
  });

  it("includes only the compact check for a waiting outcome", async () => {
    const outcome = await Effect.runPromise(
      applyProject(adapter(baseCheck(), detail(), () => detail()), chat),
    );
    expect(outcome.state).toBe("waiting_for_user");
    const output = applyOutput(outcome);
    expect(field(field(output.data, "check"), "detail")).toBe("compact");
    expect(field(field(output.data, "check"), "manifest")).toBeUndefined();
    expect(field(field(output.data, "check"), "snapshot")).toBeDefined();
    expect(output.text).toContain("check:");
    expect(output.text).not.toContain("next: ballast_apply requests a reload");
  });
});

describe("status naming", () => {
  it("separates the derived state from the service status", () => {
    const output = formatStatus(
      detail({ summary: { ...chat, status: "stopped" } }),
      [],
      [],
    );
    expect(output.text).toContain("state stopped");
    expect(output.text).toContain("service status stopped");
    expect(field(output.data, "state")).toBe("stopped");
    expect(field(output.data, "serviceStatus")).toBe("stopped");
  });

  it("deduplicates repeated project issues", () => {
    const issue = {
      id: "worker-exited",
      kind: "worker-exited" as const,
      severity: "error" as const,
      title: "Worker exited",
      at: 0,
    };
    const output = formatStatus(
      detail({ summary: { ...chat, status: "failed", issues: [issue, issue] }, issues: [issue, issue] }),
      [],
      [],
    );
    expect((field(output.data, "issues") as ReadonlyArray<unknown>).length).toBe(1);
    expect(output.text.match(/Worker exited/g)?.length).toBe(1);
  });
});
