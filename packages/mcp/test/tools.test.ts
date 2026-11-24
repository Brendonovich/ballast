import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { emptyProjectManifest } from "@ballast/agent-protocol";
import type {
  ArtifactSummary,
  ConnectionSummary,
  HealthStatus,
  ProjectConsentRequest,
  ProjectDetail,
  ProjectSummary,
} from "@ballast/agent-protocol";

import {
  applyProject,
  checkText,
  declarationUnits,
  normalizeSourceLocation,
  requirementLine,
  requirementViews,
} from "../src/adapter.ts";
import type { CheckResult, ProjectAdapter } from "../src/adapter.ts";
import { formatCatalog, selectCatalog } from "../src/catalog.ts";
import {
  missingFeatureOf,
  toolError,
  unsupportedServiceError,
} from "../src/errors.ts";
import { GUIDE } from "../src/guide.ts";
import { formatStatus, loadArtifacts, statusState } from "../src/tools.ts";

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
  requirements: [],
  units: [],
  ...overrides,
});

const health: HealthStatus = {
  ok: true,
  uptimeMs: 1,
  projects: { total: 1, running: 0, needsConsent: 0, error: 0 },
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

describe("checkText", () => {
  it("labels a run as non-durable without implying a loop", () => {
    const manifest = {
      ...emptyProjectManifest("proj_test", "ballast.ts"),
      runs: [{ name: "ready", source: { file: "ballast.ts", line: 10, column: 2 } }],
    };
    const text = checkText(
      baseCheck({
        manifest,
        units: [
          {
            kind: "run",
            name: "ready",
            status: "active",
            source: { file: "ballast.ts", line: 10, column: 2 },
          },
        ],
      }),
    );
    expect(text).toContain("run ready @ ballast.ts:10 — run (non-durable)");
    expect(text).not.toContain("run loop");
  });

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

  it("prints real source links for units", () => {
    const text = checkText(
      baseCheck({
        units: [
          {
            kind: "topic",
            name: "tick",
            source: { file: "src/a.ts", line: 6, column: 20 },
            status: "active",
          },
        ],
      }),
    );
    expect(text).toContain("src/a.ts:6");
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
          { name: "Snapshot", kind: "query" as const, stream: false },
          { name: "Reset", kind: "action" as const, stream: false },
          { name: "Chat", kind: "stream" as const, stream: true },
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

  it("reports artifact-only changes as a hot reload", () => {
    const text = checkText(baseCheck({ changes: [
      { kind: "artifact", name: "dashboard", change: "changed" },
    ] }), {
      artifacts: [],
      declarations: [],
      artifactOnly: true,
      requiresWorkerRestart: false,
    });
    expect(text).toContain("reload: artifact-only (hot reload; worker stays)");
  });

  it("reports API changes as a worker restart", () => {
    const text = checkText(baseCheck({ changes: [
      { kind: "api", name: "api", change: "changed" },
    ] }), {
      artifacts: [],
      declarations: [],
      artifactOnly: false,
      requiresWorkerRestart: true,
    });
    expect(text).toContain("reload: restarts worker");
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

  it("explains the version mismatch and tells the user how to restart", () => {
    const error = unsupportedServiceError(cause, "0.1.0");
    expect(error?.kind).toBe("unsupported-service");
    expect(error?.feature).toBe("ListArtifacts");
    expect(error?.serviceVersion).toBe("0.1.0");
    expect(error?.message).toContain(
      "The running Ballast service (version 0.1.0) is older than this MCP and lacks project artifact support (ListArtifacts).",
    );
    expect(error?.message).toContain("Restart the Ballast app");
    expect(error?.message).toContain("pnpm --filter @ballast/desktop dev");
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

  it("omits artifacts from check with a note", () => {
    const message = unsupportedServiceError(cause, "0.1.0")?.message ?? "";
    const text = checkText(baseCheck(), {
      artifacts: [],
      declarations: [],
      artifactOnly: false,
      requiresWorkerRestart: false,
      artifactNote: message,
    });
    expect(text).toContain("artifacts: unavailable — The running Ballast service");
    expect(text).toContain("lacks project artifact support (ListArtifacts)");
  });

  it("omits artifacts from status with a note", () => {
    const message = unsupportedServiceError(cause, "0.1.0")?.message ?? "";
    const output = formatStatus(detail(), [], [], message);
    expect(output.text).toContain("artifacts: unavailable — The running Ballast service");
    expect(output.text).toContain("lacks project artifact support (ListArtifacts)");
    expect(output.text).not.toContain("dashboard");
  });
});

describe("requirement views", () => {
  it("formats bound, proposed, unbound and missing requirements", () => {
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
    expect(views.map(requirementLine)).toEqual([
      'twitch/broadcaster → bound to "My Twitch" (connected)',
      'obs/main → proposed: "Studio OBS" (confirm at Start)',
      "fake/main → none: user must add a fake connection in the Ballast app",
      'midi/controller → bound to "conn_gone" (missing)',
    ]);
  });

  it("says the user must add an integration when none are compatible", () => {
    const [view] = requirementViews(
      [{ integration: "twitch", slot: "bot", location: "either" }],
      [],
    );
    expect(view === undefined ? "" : requirementLine(view)).toContain(
      "none: user must add a twitch connection in the Ballast app",
    );
  });

  it("counts compatible instances for an unbound slot", () => {
    const [view] = requirementViews(
      [{ integration: "obs", slot: "main", location: "local" }],
      [
        connection("conn_obs_1", "obs", "Studio OBS"),
        connection("conn_obs_2", "obs", "Laptop OBS"),
      ],
    );
    expect(view === undefined ? "" : requirementLine(view)).toBe(
      "obs/main → unbound: 2 compatible connections available",
    );
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
    expect(view === undefined ? "" : requirementLine(view)).toBe(
      "twitch/broadcaster → none: user must add a twitch connection in the Ballast app · needs user:read:chat, user:write:chat",
    );
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
    expect(view?.missingScopes).toEqual([]);
    expect(view === undefined ? "" : requirementLine(view)).toBe(
      'twitch/broadcaster → bound to "My Twitch" (connected)',
    );
  });
});

describe("status vocabulary", () => {
  it("uses waiting_for_user with a reason for pending consent", () => {
    expect(
      statusState({ ...summary, status: "needs-consent" }, detail({ pendingConsent: consent })),
    ).toEqual({ state: "waiting_for_user", reason: "consent" });
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
    expect(fake?.requests[0]?.scopes).toEqual([]);
    expect(fake?.requests[0]?.grantedBy).toContain("fake/*");
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
    expect(formatCatalog(first)).toContain("truncated");
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

describe("guide", () => {
  it("covers the authoring contract", () => {
    expect(GUIDE).toContain("Ballast.Timer");
    expect(GUIDE).toContain("Ballast.run");
    expect(GUIDE).toContain("account.helix");
    expect(GUIDE).toContain("Effect.sleep");
    expect(GUIDE).toContain("Effect.catchCause");
    expect(GUIDE).toContain("Effect.catchTag");
    expect(GUIDE).toContain("Param.strings");
    expect(GUIDE).toContain("OBS.scenes(obs)");
    expect(GUIDE).toContain("satisfies Ballast.Project");
    expect(GUIDE).toContain("Params are live");
    expect(GUIDE).toContain("Ballast.Runtime");
    expect(GUIDE).not.toContain("Timer.unit");
    expect(GUIDE).not.toContain("being removed");
  });
});
