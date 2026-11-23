import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { emptyProjectManifest } from "@ballast/agent-protocol";
import type { HealthStatus, ProjectDetail, ProjectSummary } from "@ballast/agent-protocol";

import { applyProject, checkText } from "../src/adapter.ts";
import type { CheckResult, ProjectAdapter } from "../src/adapter.ts";
import { formatCatalog, selectCatalog } from "../src/catalog.ts";
import { GUIDE } from "../src/guide.ts";

const summary: ProjectSummary = {
  id: "proj_test",
  name: "Test",
  root: "/tmp/ballast-test",
  entry: "ballast.ts",
  enabled: false,
  status: "stopped",
  unitCount: 2,
  createdAt: 0,
  updatedAt: 0,
};

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  summary,
  manifest: emptyProjectManifest("proj_test", "ballast.ts"),
  units: [],
  scripts: [],
  ...overrides,
});

const health: HealthStatus = {
  ok: true,
  uptimeMs: 1,
  projects: { total: 1, running: 0, needsConsent: 0, error: 0 },
  scripts: { total: 0, running: 0, needsConsent: 0, error: 0 },
  connections: { total: 0, connected: 0, error: 0 },
  cloud: "unlinked",
  lastLogSeq: 0,
  lastEventSeq: 0,
};

const baseCheck = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  project: summary,
  entry: "ballast.ts",
  ok: true,
  diagnostics: [],
  units: [],
  changes: [],
  requiresConsent: false,
  missingConnections: [],
  missingScopes: [],
  ...overrides,
});

interface AdapterState {
  readonly check: CheckResult;
  readonly project: ProjectDetail;
  restarts: number;
}

const adapter = (state: AdapterState): ProjectAdapter => ({
  listProjects: () => Effect.succeed([summary]),
  resolveProject: () => Effect.succeed(summary),
  getProject: () => Effect.succeed(state.project),
  registerProject: () => Effect.succeed(state.project),
  checkProject: () => Effect.succeed(state.check),
  restartProject: () => {
    state.restarts += 1;
    return Effect.succeed(
      detail({ summary: { ...summary, enabled: true, status: "running" }, appliedAt: 1 }),
    );
  },
  listConnections: () => Effect.succeed([]),
  health: () => Effect.succeed(health),
  logs: () => Effect.succeed([]),
  events: () => Effect.succeed([]),
});

describe("ballast_apply", () => {
  it("never approves consent", async () => {
    const state = { check: baseCheck({ requiresConsent: true }), project: detail(), restarts: 0 };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("waiting_for_user");
    expect(outcome.reason).toBe("consent");
    expect(state.restarts).toBe(0);
  });

  it("never performs the first start", async () => {
    const state = { check: baseCheck(), project: detail(), restarts: 0 };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("waiting_for_user");
    expect(outcome.reason).toBe("start");
    expect(state.restarts).toBe(0);
  });

  it("waits for a missing connection instead of restarting", async () => {
    const state = {
      check: baseCheck({
        missingConnections: [{ integration: "obs", slot: "main", location: "local" as const }],
      }),
      project: detail({ summary: { ...summary, enabled: true }, appliedAt: 1 }),
      restarts: 0,
    };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("waiting_for_user");
    expect(outcome.reason).toBe("connection");
    expect(state.restarts).toBe(0);
  });

  it("restarts a running project that has no new permissions", async () => {
    const state = {
      check: baseCheck(),
      project: detail({
        summary: { ...summary, enabled: true, status: "running" },
        appliedAt: 1,
      }),
      restarts: 0,
    };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("reloaded");
    expect(state.restarts).toBe(1);
  });

  it("does not restart an invalid project", async () => {
    const state = {
      check: baseCheck({
        ok: false,
        diagnostics: [{ file: "ballast.ts", line: 3, column: 7, code: "TS2322", message: "Bad" }],
      }),
      project: detail({ summary: { ...summary, enabled: true }, appliedAt: 1 }),
      restarts: 0,
    };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("invalid");
    expect(state.restarts).toBe(0);
  });
});

describe("checkText", () => {
  it("prints file:line:column and the TS code", () => {
    const text = checkText(
      baseCheck({
        ok: false,
        diagnostics: [
          {
            file: "src/a.ts",
            line: 14,
            column: 17,
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
          },
        ],
      }),
    );
    expect(text).toContain("src/a.ts:14:17 TS2322 Type 'number' is not assignable to type 'string'.");
    expect(text).toContain("check: FAILED");
  });
});

describe("catalog", () => {
  it("is an index by default and does not dump every topic", () => {
    const selection = selectCatalog({});
    expect(selection.integrations).toHaveLength(8);
    expect(selection.integrations.every((integration) => integration.topics.length === 0)).toBe(true);
    expect(selection.integrations.every((integration) => integration.requests.length === 0)).toBe(true);
    expect(selection.connectionKinds).toHaveLength(5);
  });

  it("lists topics and requests for one integration", () => {
    const selection = selectCatalog({ integration: "fake" });
    const fake = selection.integrations[0];
    expect(fake?.topics.map((topic) => topic.topic).sort()).toEqual(["fake/chat", "fake/tick"]);
    expect(fake?.requests.map((request) => request.name)).toEqual(["fake/echo"]);
  });

  it("includes Effect-Schema-derived JSON Schemas on request", () => {
    const selection = selectCatalog({ integration: "fake", includeSchemas: true });
    const tick = selection.integrations[0]?.topics.find((topic) => topic.topic === "fake/tick");
    expect(tick?.schema).toMatchObject({ type: "object" });
    expect(formatCatalog(selection)).toContain("schema:");
  });

  it("filters to connection kinds", () => {
    const selection = selectCatalog({ kind: "connections" });
    expect(selection.connectionKinds).toHaveLength(5);
    expect(selection.integrations.every((integration) => integration.topics.length === 0)).toBe(true);
    expect(selection.integrations.every((integration) => integration.requests.length === 0)).toBe(true);
  });
});

describe("guide", () => {
  it("covers the authoring contract", () => {
    expect(GUIDE).toContain("Ballast.Timer");
    expect(GUIDE).toContain("Ballast.run");
    expect(GUIDE).toContain("account.helix");
    expect(GUIDE).toContain("Effect.sleep");
  });
});
