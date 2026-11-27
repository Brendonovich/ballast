import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { emptyProjectManifest } from "@ballast/agent-protocol";
import type {
  ArtifactSummary,
  ConnectionSummary,
  HealthStatus,
  ProjectConsentRequest,
  ProjectDetail,
  ProjectIssue,
  ProjectSummary,
} from "@ballast/agent-protocol";

import {
  applyProject,
  declarationUnits,
  normalizeSourceLocation,
  requirementViews,
} from "../src/adapter.ts";
import type { CheckResult, ProjectAdapter } from "../src/adapter.ts";
import { selectCatalog } from "../src/catalog.ts";
import {
  missingFeatureOf,
  toolError,
  unsupportedServiceError,
} from "../src/errors.ts";
import { loadArtifacts, statusState } from "../src/tools.ts";

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
  issues: [],
};

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  summary,
  manifest: emptyProjectManifest("proj_test", "ballast.ts"),
  requirements: [],
  units: [],
  issues: [],
  ...overrides,
});

const health: HealthStatus = {
  ok: true,
  uptimeMs: 1,
  projects: {
    total: 1,
    stopped: 1,
    starting: 0,
    running: 0,
    needsUser: 0,
    failed: 0,
    needsConsent: 0,
    error: 0,
  },
  connections: { total: 0, connected: 0, error: 0 },
  cloud: "unlinked",
  lastLogSeq: 0,
  lastEventSeq: 0,
};

const connection = (
  id: string,
  integration: string,
  label: string,
  status: ConnectionSummary["status"] = "connected",
): ConnectionSummary => ({
  id,
  integration,
  title: integration,
  label,
  location: "local",
  mode: "auto",
  status,
  fields: [],
  values: [],
  scopes: { granted: [], required: [], missing: [] },
  boundBy: [],
  requiresAuth: false,
});

const baseCheck = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  summary,
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

interface AdapterState {
  readonly check: CheckResult;
  readonly project: ProjectDetail;
  restarts: number;
}

const adapter = (state: AdapterState): ProjectAdapter => ({
  listProjects: () => Effect.succeed([summary]),
  resolveProject: () => Effect.succeed(summary),
  getProject: () => Effect.succeed(state.project),
  createProject: () => Effect.succeed(state.project),
  listProjectFiles: () =>
    Effect.succeed({
      entry: "ballast.ts",
      files: [
        { path: "ballast.ts", kind: "file" as const },
        { path: "package.json", kind: "file" as const },
        { path: "tsconfig.json", kind: "file" as const },
        { path: "AGENTS.md", kind: "file" as const },
      ],
    }),
  checkProject: () => Effect.succeed(state.check),
  listArtifacts: () => Effect.succeed([]),
  queryEventHistory: () => Effect.succeed({ entries: [] }),
  listEventHistorySubscriptions: () => Effect.succeed({ subscriptions: [] }),
  restartProject: () => {
    state.restarts += 1;
    return Effect.succeed(
      detail({ summary: { ...summary, enabled: true, status: "running" }, appliedAt: 1 }),
    );
  },
  shareProject: () => Effect.fail(toolError("sharing is not used in these tests")),
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

  it("waits for an unbound requirement instead of restarting", async () => {
    const state = {
      check: baseCheck({
        requirements: [{ integration: "obs", slot: "main", location: "local" as const }],
        missingConnections: [{ integration: "obs", slot: "main", location: "local" as const }],
      }),
      project: detail({ summary: { ...summary, enabled: true }, appliedAt: 1 }),
      restarts: 0,
    };
    const outcome = await Effect.runPromise(applyProject(adapter(state), summary));
    expect(outcome.state).toBe("waiting_for_user");
    expect(outcome.reason).toBe("connections");
    expect(outcome.message).toContain("obs/main");
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
    expect(outcome.state).toBe("running");
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
    expect(outcome.state).toBe("error");
    expect(outcome.reason).toBe("invalid");
    expect(state.restarts).toBe(0);
  });
});

describe("source normalization", () => {
  it("recovers a project-relative source from a repo-relative path", () => {
    expect(
      normalizeSourceLocation("/Users/me/ballast-projects/chat", {
        file: "../../ballast-projects/chat/src/a.ts",
        line: 4,
        column: 2,
      }),
    ).toEqual({ file: "src/a.ts", line: 4, column: 2 });
  });

  it("drops core frames outside the project", () => {
    expect(
      normalizeSourceLocation("/Users/me/ballast-projects/chat", {
        file: "../../core/src/timer.ts",
        line: 394,
        column: 14,
      }),
    ).toBeUndefined();
  });

});

const consent: ProjectConsentRequest = {
  id: "consent_test",
  projectId: summary.id,
  projectName: summary.name,
  createdAt: 0,
  reason: "scopes",
  summary: "Adds scopes: fake:read",
  diff: {
    requiresConsent: true,
    added: { connections: [], topics: [], requests: [], scopes: ["fake:read"], params: [] },
    removed: { connections: [], topics: [], requests: [], scopes: [], params: [] },
  },
  bindings: [],
};
describe("artifact check output", () => {
  it("lists artifact, api and store declarations with sources", () => {
    const manifest = {
      ...emptyProjectManifest("proj_test", "ballast.ts"),
      artifacts: [
        {
          name: "dashboard",
          title: "Stream dashboard",
          entry: "artifacts/dashboard/main.tsx",
          source: { file: "ballast.ts", line: 8, column: 10 },
        },
      ],
      api: {
        source: { file: "ballast.ts", line: 12, column: 10 },
        procedures: [
          { name: "Snapshot", stream: false },
          { name: "Reset", stream: false },
          { name: "Chat", stream: true },
        ],
      },
      stores: [
        {
          name: "messages",
          kind: "counter" as const,
          initial: 0,
          source: { file: "ballast.ts", line: 6, column: 20 },
        },
      ],
    };
    const artifacts: ReadonlyArray<ArtifactSummary> = [
      {
        name: "dashboard",
        title: "Stream dashboard",
        entry: "artifacts/dashboard/main.tsx",
        fingerprint: "abc",
        status: "ready",
      },
    ];
    const declarations = declarationUnits(manifest, artifacts, "/tmp/project", true);
    expect(declarations.map((declaration) => declaration.kind + ":" + declaration.name)).toEqual([
      "artifact:dashboard",
      "api:api",
      "store:messages",
    ]);
    expect(declarations[0]?.source?.file).toBe("ballast.ts");
  });

});

describe("stale service capabilities", () => {
  const cause = {
    _id: "Cause",
    defect: "Unknown request tag: ListArtifacts",
  };

  it("recognises an unknown RPC tag nested in a Cause", () => {
    expect(missingFeatureOf(cause)).toBe("ListArtifacts");
    expect(
      missingFeatureOf({
        _id: "Cause",
        failures: [],
        defects: [{ _id: "RpcClientDefect", message: "Unknown request tag: ListArtifacts" }],
        interrupts: [],
      }),
    ).toBe("ListArtifacts");
    expect(missingFeatureOf(new Error("Unknown request tag: QueryEventHistory"))).toBe(
      "QueryEventHistory",
    );
    expect(missingFeatureOf(new Error("socket closed"))).toBeUndefined();
  });

  it("maps only a missing RPC feature to an unsupported-service error", () => {
    const error = unsupportedServiceError(cause, "0.1.0");
    expect(error?.kind).toBe("unsupported-service");
    expect(error?.feature).toBe("ListArtifacts");
    expect(error?.serviceVersion).toBe("0.1.0");
    expect(unsupportedServiceError(new Error("socket closed"), undefined)).toBeUndefined();
  });

  it("turns an unsupported artifact listing into an empty list with a note", async () => {
    const error = unsupportedServiceError(cause, "0.1.0");
    if (error === undefined) throw new Error("expected an unsupported-service error");
    const stale: ProjectAdapter = {
      ...adapter({ check: baseCheck(), project: detail(), restarts: 0 }),
      listArtifacts: () => Effect.fail(error),
    };
    const listing = await Effect.runPromise(loadArtifacts(stale, summary.id));
    expect(listing.artifacts).toEqual([]);
    expect(listing.note).toBe(error.message);

    const broken: ProjectAdapter = {
      ...adapter({ check: baseCheck(), project: detail(), restarts: 0 }),
      listArtifacts: () => Effect.fail(toolError("socket closed")),
    };
    const other = await Effect.runPromise(loadArtifacts(broken, summary.id));
    expect(other.artifacts).toEqual([]);
    expect(other.note).toBeUndefined();
  });

});

describe("requirement views", () => {
  it("resolves bound, proposed, unbound and dangling bindings", () => {
    const connections = [
      connection("conn_twitch", "twitch", "My Twitch"),
      connection("conn_obs", "obs", "Studio OBS"),
      connection("conn_obs_2", "obs", "Laptop OBS", "disconnected"),
    ];
    const views = requirementViews(
      [
        {
          integration: "twitch",
          slot: "broadcaster",
          location: "either",
          boundInstanceId: "conn_twitch",
        },
        {
          integration: "obs",
          slot: "main",
          location: "local",
          proposedInstanceId: "conn_obs",
        },
        { integration: "fake", slot: "main", location: "local" },
        {
          integration: "midi",
          slot: "controller",
          location: "local",
          boundInstanceId: "conn_gone",
        },
      ],
      connections,
    );
    expect(views.map((view) => [view.state, view.instanceId])).toEqual([
      ["bound", "conn_twitch"],
      ["proposed", "conn_obs"],
      ["unbound", undefined],
      ["missing", "conn_gone"],
    ]);
  });

  it("counts compatible instances for an unbound slot", () => {
    const [view] = requirementViews(
      [{ integration: "obs", slot: "main", location: "local" }],
      [
        connection("conn_obs_1", "obs", "Studio OBS"),
        connection("conn_obs_2", "obs", "Laptop OBS"),
        connection("conn_twitch", "twitch", "My Twitch"),
      ],
    );
    expect(view?.state).toBe("unbound");
    expect(view?.compatibleCount).toBe(2);
  });

  it("derives required scopes from the manifest even when unbound", () => {
    const manifest = {
      ...emptyProjectManifest("proj_test", "ballast.ts"),
      topics: [
        {
          name: "chat",
          integration: "twitch",
          slot: "broadcaster",
          topic: "twitch/channel.chat.message",
          scopes: ["user:read:chat"],
          onStale: "drop" as const,
          maxAgeMs: 60_000,
        },
      ],
      requests: [
        {
          integration: "twitch",
          slot: "broadcaster",
          request: "helix/sendChatMessage",
          scopes: ["user:write:chat"],
        },
      ],
    };
    const [view] = requirementViews(
      [{ integration: "twitch", slot: "broadcaster", location: "either" }],
      [],
      manifest,
    );
    expect(view?.missingScopes).toEqual(["user:read:chat", "user:write:chat"]);
  });

  it("does not report scopes already granted by a bound instance", () => {
    const bound = {
      ...connection("conn_twitch", "twitch", "My Twitch"),
      scopes: { granted: ["user:read:chat", "user:write:chat"], required: [], missing: [] },
    };
    const manifest = {
      ...emptyProjectManifest("proj_test", "ballast.ts"),
      topics: [
        {
          name: "chat",
          integration: "twitch",
          slot: "broadcaster",
          topic: "twitch/channel.chat.message",
          scopes: ["user:read:chat"],
          onStale: "drop" as const,
          maxAgeMs: 60_000,
        },
      ],
    };
    const [view] = requirementViews(
      [
        {
          integration: "twitch",
          slot: "broadcaster",
          location: "either",
          boundInstanceId: "conn_twitch",
        },
      ],
      [bound],
      manifest,
    );
    expect(view?.requiredScopes).toEqual(["user:read:chat"]);
    expect(view?.missingScopes).toEqual([]);
  });
});

describe("status vocabulary", () => {
  it("uses waiting_for_user with a reason for pending consent", () => {
    expect(
      statusState({ ...summary, status: "needs-user" }, detail({ pendingConsent: consent })),
    ).toEqual({ state: "waiting_for_user", reason: "consent" });
  });

  it("separates failed projects from a failed change over a live worker", () => {
    expect(statusState({ ...summary, status: "failed" }, detail())).toEqual({
      state: "error",
    });
    const changeIssue: ProjectIssue = {
      id: "change-not-applied",
      kind: "change-not-applied",
      severity: "error",
      title: "Latest change not applied",
      at: 0,
    };
    expect(
      statusState(
        { ...summary, status: "running", issues: [changeIssue] },
        detail({ issues: [changeIssue] }),
      ),
    ).toEqual({ state: "previous_version_running_latest_failed" });
  });

  it("uses waiting_for_user with reason connections for an unbound requirement", () => {
    expect(
      statusState(
        { ...summary, status: "stopped" },
        detail({
          requirements: [{ integration: "obs", slot: "main", location: "local" }],
        }),
      ),
    ).toEqual({ state: "waiting_for_user", reason: "connections" });
  });

  it("uses running for a healthy project", () => {
    expect(statusState({ ...summary, status: "running" }, detail())).toEqual({
      state: "running",
    });
  });
});

describe("catalog", () => {
  it("is an index by default and does not dump every topic", () => {
    const selection = selectCatalog({});
    expect(selection.integrations).toHaveLength(9);
    expect(selection.integrations.every((integration) => integration.topics.length === 0)).toBe(true);
    expect(selection.integrations.every((integration) => integration.requests.length === 0)).toBe(true);
    expect(selection.connectionKinds).toHaveLength(4);
  });

  it("lists topics and requests for one integration", () => {
    const selection = selectCatalog({ integration: "fake" });
    const fake = selection.integrations[0];
    expect(fake?.topics.map((topic) => topic.topic).sort()).toEqual(["fake/chat", "fake/tick"]);
    expect(fake?.requests.map((request) => request.name)).toEqual(["fake/echo"]);
    expect(fake?.requests[0]?.scopes).toEqual([]);
    expect(fake?.requests[0]?.grantedBy).toContain("fake/*");
  });

  it("includes Effect-Schema-derived JSON Schemas on request", () => {
    const selection = selectCatalog({ integration: "fake", includeSchemas: true });
    const tick = selection.integrations[0]?.topics.find((topic) => topic.topic === "fake/tick");
    expect(tick?.schema).toMatchObject({ type: "object" });
  });

  it("filters to connection kinds", () => {
    const selection = selectCatalog({ kind: "connections" });
    expect(selection.connectionKinds).toHaveLength(4);
    expect(selection.integrations.every((integration) => integration.topics.length === 0)).toBe(true);
    expect(selection.integrations.every((integration) => integration.requests.length === 0)).toBe(true);
  });

  it("filters a single topic or request by name", () => {
    const topic = selectCatalog({ integration: "twitch", topic: "ChatMessage" });
    expect(topic.integrations[0]?.topics.map((entry) => entry.name)).toEqual(["ChatMessage"]);
    expect(topic.integrations[0]?.requests).toEqual([]);

    const request = selectCatalog({
      integration: "obs",
      request: "SetCurrentProgramScene",
    });
    expect(request.integrations[0]?.requests.map((entry) => entry.name)).toEqual([
      "obs/SetCurrentProgramScene",
    ]);
    expect(request.integrations[0]?.topics).toEqual([]);
  });

  it("reports truncation and pages with offset", () => {
    const first = selectCatalog({ integration: "obs", kind: "requests", limit: 5 });
    expect(first.integrations[0]?.requests).toHaveLength(5);
    const page = first.pages[0];
    expect(page?.requestMatches).toBeGreaterThan(5);
    expect(page?.requestNextOffset).toBe(5);
    const second = selectCatalog({
      integration: "obs",
      kind: "requests",
      limit: 5,
      offset: 5,
    });
    expect(second.integrations[0]?.requests).toHaveLength(5);
    expect(second.integrations[0]?.requests[0]?.name).not.toBe(
      first.integrations[0]?.requests[0]?.name,
    );
  });
});
