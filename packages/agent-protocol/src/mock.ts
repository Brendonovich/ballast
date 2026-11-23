import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { CloudStatus } from "./cloud.ts";
import { cloudUnlinked } from "./cloud.ts";
import type { ConnectionSummary } from "./connections.ts";
import {
  connectionIntegrations,
  fakeFields,
  obsFields,
  twitchFields,
} from "./connections.ts";
import type { AgentError, ParamValue } from "./common.ts";
import { agentError } from "./common.ts";
import type { LogEntry, EventRecord } from "./logs.ts";
import type {
  ProjectConsentRequest,
  ProjectRequirement,
  ProjectSummary,
  UnitSummary,
} from "./project.ts";
import { emptyProjectManifest } from "./project.ts";
import type {
  ConsentRequest,
  ManifestDiff,
  ParamView,
  ScriptDetail,
  ScriptManifest,
  ScriptSummary,
} from "./scripts.ts";
import { scriptView } from "./scripts.ts";
import type { HealthStatus, ServiceInfo } from "./service.ts";
import { AGENT_API_VERSION } from "./service.ts";
import type { ServiceEvent, ServiceSnapshot } from "./events.ts";
import { AgentRpcs } from "./rpc.ts";

/**
 * A deterministic-ish in-memory agent used by tests and by the UI before the
 * real service exists. It implements the whole RPC group, mutates realistic
 * fake data and publishes the same state events the real service will.
 *
 * Start with `MockAgentLayer`; every call is connected through the real
 * Effect RPC machinery (see `RpcTest`).
 */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const sourceSha256 = (content: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(content),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  });

interface MockState {
  readonly info: ServiceInfo;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  readonly projectOrder: ReadonlyArray<string>;
  /** Keyed by `projectId + "\u0000" + scriptId`. */
  readonly scripts: ReadonlyMap<string, ScriptDetail>;
  readonly scriptOrder: ReadonlyArray<string>;
  readonly connections: ReadonlyMap<string, ConnectionSummary>;
  readonly connectionOrder: ReadonlyArray<string>;
  readonly consents: ReadonlyMap<string, ConsentRequest>;
  readonly consentOrder: ReadonlyArray<string>;
  readonly cloud: CloudStatus;
  readonly logs: ReadonlyArray<LogEntry>;
  readonly events: ReadonlyArray<EventRecord>;
  readonly nextLogSeq: number;
  readonly nextEventSeq: number;
  readonly nextProjectSeq: number;
}

interface MockStoreService {
  readonly state: Ref.Ref<MockState>;
  readonly changes: PubSub.PubSub<ServiceEvent>;
  readonly logEntries: PubSub.PubSub<LogEntry>;
  readonly eventRecords: PubSub.PubSub<EventRecord>;
}

class MockStore extends Context.Service<MockStore, MockStoreService>()(
  "ballast/agent-protocol/MockStore",
) {}

const base = Date.now() - 3 * HOUR;

const scriptKey = (projectId: string, scriptId: string): string =>
  `${projectId}\u0000${scriptId}`;

const mainProject: ProjectSummary = {
  id: "proj_main",
  name: "Main Channel",
  root: "/Users/streamer/Ballast/main",
  entry: "ballast.ts",
  enabled: true,
  status: "running",
  unitCount: 4,
  createdAt: base - 30 * 24 * HOUR,
  updatedAt: base + 2 * HOUR,
};

const altProject: ProjectSummary = {
  id: "proj_alt",
  name: "Second Channel",
  root: "/Users/streamer/Ballast/second",
  entry: "ballast.ts",
  enabled: false,
  status: "stopped",
  unitCount: 4,
  createdAt: base - 12 * 24 * HOUR,
  updatedAt: base + 55 * MINUTE,
};

const param = (input: ParamView): ParamView => input;

const redeemManifest: ScriptManifest = {
  params: [
    param({
      key: "rewardTitle",
      type: "string",
      title: "Reward title",
      default: "Hydrate",
      value: "Hydrate",
      required: true,
    }),
    param({
      key: "scene",
      type: "enum",
      title: "Scene",
      options: ["Starting Soon", "Game", "BRB", "Just Chatting"],
      optionsSource: { integration: "obs", slot: "main", source: "scenes" },
      value: "Game",
      required: true,
    }),
    param({
      key: "holdSeconds",
      type: "number",
      title: "Hold for (seconds)",
      description: "Switch back to the previous scene after this long. 0 keeps the scene.",
      default: 5,
      value: 5,
      required: false,
    }),
  ],
  connections: [
    {
      integration: "twitch",
      slot: "broadcaster",
      location: "either",
      connectionId: "twitch/broadcaster",
      connectionStatus: "connected",
    },
    {
      integration: "obs",
      slot: "main",
      location: "local",
      connectionId: "obs/main",
      connectionStatus: "connected",
    },
  ],
  topics: [
    {
      integration: "twitch",
      slot: "broadcaster",
      topic: "twitch/channel.channel_points_custom_reward_redemption.add",
      scopes: ["channel:read:redemptions"],
      onStale: "drop",
      maxAgeMs: 60_000,
      condition: { broadcaster_user_id: { slot: "broadcaster" } },
    },
  ],
  requests: [
    {
      integration: "obs",
      slot: "main",
      request: "obs/SetCurrentProgramScene",
      scopes: [],
    },
  ],
  unresolved: [],
  timers: [],
};

const cheerManifest: ScriptManifest = {
  params: [
    param({
      key: "message",
      type: "string",
      title: "Chat message",
      default: "Thanks for the bits!",
      value: "Thanks for the bits!",
      required: true,
    }),
    param({
      key: "minBits",
      type: "number",
      title: "Minimum bits",
      default: 100,
      required: false,
    }),
  ],
  connections: [
    {
      integration: "twitch",
      slot: "broadcaster",
      location: "either",
      connectionId: "twitch/broadcaster",
      connectionStatus: "connected",
    },
  ],
  topics: [
    {
      integration: "twitch",
      slot: "broadcaster",
      topic: "twitch/channel.cheer",
      scopes: ["bits:read"],
      onStale: "drop",
      maxAgeMs: 60_000,
      condition: { broadcaster_user_id: { slot: "broadcaster" } },
    },
  ],
  requests: [
    {
      integration: "twitch",
      slot: "broadcaster",
      request: "twitch/SendChatMessage",
      scopes: ["user:write:chat"],
    },
  ],
  unresolved: [],
  timers: [],
};

const tickManifest: ScriptManifest = {
  params: [
    param({
      key: "prefix",
      type: "string",
      title: "Prefix",
      default: ">",
      value: ">",
      required: false,
    }),
  ],
  connections: [
    {
      integration: "fake",
      slot: "main",
      location: "local",
      connectionId: "fake/main",
      connectionStatus: "connected",
    },
  ],
  topics: [
    {
      integration: "fake",
      slot: "main",
      topic: "fake/tick",
      scopes: ["fake:read"],
      onStale: "drop",
      maxAgeMs: 60_000,
    },
  ],
  requests: [
    {
      integration: "fake",
      slot: "main",
      request: "fake/*",
      scopes: [],
    },
  ],
  unresolved: [],
  timers: [],
};

const rotationManifest: ScriptManifest = {
  params: [
    param({
      key: "intervalSeconds",
      type: "number",
      title: "Rotate every (seconds)",
      default: 30,
      value: 30,
      required: true,
    }),
  ],
  connections: [
    {
      integration: "obs",
      slot: "main",
      location: "local",
      connectionId: "obs/main",
      connectionStatus: "connected",
    },
    {
      integration: "obs",
      slot: "secondary",
      location: "local",
      connectionId: "obs/secondary",
      connectionStatus: "unconfigured",
    },
  ],
  topics: [],
  requests: [
    {
      integration: "obs",
      slot: "secondary",
      request: "obs/SetCurrentProgramScene",
      scopes: [],
    },
  ],
  unresolved: [],
  timers: [],
};

const summary = (input: ScriptSummary): ScriptSummary => input;

const consentFor = (input: {
  readonly id: string;
  readonly projectId: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly createdAt: number;
  readonly diff: ManifestDiff;
  readonly summary: string;
}): ConsentRequest => ({
  id: input.id,
  projectId: input.projectId,
  scriptId: input.scriptId,
  scriptName: input.scriptName,
  createdAt: input.createdAt,
  reason: "both",
  summary: input.summary,
  diff: input.diff,
});

const emptyDiff = (): ManifestDiff => ({
  requiresConsent: false,
  added: { connections: [], topics: [], requests: [], scopes: [], params: [] },
  removed: { connections: [], topics: [], requests: [], scopes: [], params: [] },
});

const cheerConsent = consentFor({
  id: "consent-cheer",
  projectId: mainProject.id,
  scriptId: "scripts/cheer-alert.ts",
  scriptName: "Cheer Alert",
  createdAt: base + 2 * HOUR + 12 * MINUTE,
  summary: "Adds cheer events (bits:read) and chat messages (user:write:chat)",
  diff: {
    ...emptyDiff(),
    requiresConsent: true,
    added: {
      connections: [],
      topics: cheerManifest.topics,
      requests: cheerManifest.requests,
      scopes: ["bits:read", "user:write:chat"],
      params: cheerManifest.params,
    },
  },
});

const initialScripts = (): ReadonlyMap<string, ScriptDetail> => {
  const entries: ReadonlyArray<ScriptDetail> = [
    {
      summary: summary({
        projectId: mainProject.id,
        id: "scripts/redeem-to-scene.ts",
        name: "Redeem to Scene",
        entry: "scripts/redeem-to-scene.ts",
        status: "running",
        enabled: true,
        generation: 3,
        updatedAt: base + 2 * HOUR,
      }),
      manifest: redeemManifest,
      appliedManifest: redeemManifest,
      appliedAt: base + 2 * HOUR,
      view: scriptView(),
    },
    {
      summary: summary({
        projectId: mainProject.id,
        id: "scripts/cheer-alert.ts",
        name: "Cheer Alert",
        entry: "scripts/cheer-alert.ts",
        status: "needs-consent",
        enabled: false,
        generation: 1,
        updatedAt: base + 2 * HOUR + 12 * MINUTE,
      }),
      manifest: cheerManifest,
      pendingConsent: cheerConsent,
      view: scriptView(),
    },
    {
      summary: summary({
        projectId: altProject.id,
        id: "scripts/tick-echo.ts",
        name: "Tick Echo",
        entry: "scripts/tick-echo.ts",
        status: "stopped",
        enabled: false,
        generation: 1,
        updatedAt: base + 30 * MINUTE,
      }),
      manifest: tickManifest,
      appliedManifest: tickManifest,
      appliedAt: base + 30 * MINUTE,
      view: scriptView(),
    },
    {
      summary: summary({
        projectId: altProject.id,
        id: "scripts/scene-rotation.ts",
        name: "Scene Rotation",
        entry: "scripts/scene-rotation.ts",
        status: "error",
        enabled: true,
        generation: 2,
        updatedAt: base + 55 * MINUTE,
        lastError: "OBS obs/secondary is not connected",
      }),
      manifest: rotationManifest,
      appliedManifest: rotationManifest,
      appliedAt: base + 55 * MINUTE,
      view: scriptView(),
    },
  ];
  return new Map(
    entries.map((entry) => [
      scriptKey(entry.summary.projectId, entry.summary.id),
      entry,
    ]),
  );
};

const obsConnection = (input: {
  readonly slot: string;
  readonly label: string;
  readonly status: ConnectionSummary["status"];
  readonly url?: string;
  readonly passwordSet: boolean;
  readonly detail?: string;
}): ConnectionSummary => ({
  id: `obs/${input.slot}`,
  integration: "obs",
  title: "OBS Studio",
  label: input.label,
  location: "local",
  mode: "auto",
  status: input.status,
  fields: obsFields,
  values: [
    {
      key: "url",
      ...(input.url === undefined ? {} : { value: input.url }),
      isSecret: false,
      isSet: input.url !== undefined,
    },
    { key: "password", isSecret: true, isSet: input.passwordSet },
  ],
  scopes: { granted: [], required: [], missing: [] },
  boundBy:
    input.slot === "main"
      ? [
          { projectId: mainProject.id, slot: "main" },
        ]
      : [{ projectId: altProject.id, slot: "secondary" }],
  ...(input.detail === undefined ? {} : { detail: input.detail }),
  ...(input.status === "connected" ? { lastConnectedAt: base + 2 * HOUR } : {}),
  requiresAuth: false,
});

const twitchConnection = (input: {
  readonly slot: string;
  readonly label: string;
  readonly mode: ConnectionSummary["mode"];
  readonly status: ConnectionSummary["status"];
  readonly login?: string;
  readonly displayName?: string;
  readonly granted: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
  readonly lastError?: string;
}): ConnectionSummary => {
  const missing = input.required.filter((scope) => !input.granted.includes(scope));
  return {
    id: `twitch/${input.slot}`,
    integration: "twitch",
    title: "Twitch",
    label: input.label,
    location: "either",
    mode: input.mode,
    status: input.status,
    fields: twitchFields,
    values: [
      { key: "clientId", isSecret: false, isSet: input.mode === "local-app" },
      { key: "clientSecret", isSecret: true, isSet: input.mode === "local-app" },
      { key: "connection", isSecret: false, isSet: false },
    ],
    scopes: {
      granted: [...input.granted],
      required: [...input.required],
      missing,
    },
    boundBy:
      input.slot === "broadcaster"
        ? [
            { projectId: mainProject.id, slot: "broadcaster" },
          ]
        : [],
    ...(input.login === undefined
      ? {}
      : {
          account: {
            id: "44322889",
            login: input.login,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          },
        }),
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    ...(input.status === "connected" ? { lastConnectedAt: base + 2 * HOUR } : {}),
    requiresAuth: missing.length > 0 || input.status === "reauth-required",
  };
};

const initialConnections = (): ReadonlyMap<string, ConnectionSummary> => {
  const entries: ReadonlyArray<ConnectionSummary> = [
    obsConnection({
      slot: "main",
      label: "Main OBS",
      status: "connected",
      url: "ws://127.0.0.1:4455",
      passwordSet: true,
      detail: "OBS 31.0.2 · 4 scenes",
    }),
    obsConnection({
      slot: "secondary",
      label: "Second PC",
      status: "unconfigured",
      passwordSet: false,
    }),
    twitchConnection({
      slot: "broadcaster",
      label: "Broadcaster",
      mode: "cloud",
      status: "connected",
      login: "streamer",
      displayName: "Streamer",
      granted: ["channel:read:redemptions", "user:write:chat"],
      required: ["channel:read:redemptions", "user:write:chat"],
    }),
    twitchConnection({
      slot: "bot",
      label: "Chat bot",
      mode: "local-app",
      status: "reauth-required",
      login: "streamer_bot",
      granted: ["chat:read"],
      required: ["user:write:chat"],
      lastError: "Missing scope user:write:chat",
    }),
    {
      id: "fake/main",
      integration: "fake",
      title: "Fake",
      label: "Development",
      location: "local",
      mode: "auto",
      status: "connected",
      fields: fakeFields,
      values: [],
      scopes: { granted: ["fake:read", "fake:write"], required: [], missing: [] },
      boundBy: [{ projectId: altProject.id, slot: "main" }],
      detail: "In-process test driver",
      lastConnectedAt: base,
      requiresAuth: false,
    },
  ];
  return new Map(entries.map((connection) => [connection.id, connection]));
};

const linkedCloud: CloudStatus = {
  state: "linked",
  cloudUrl: "https://cloud.ballast.stream",
  account: {
    id: "44322889",
    login: "streamer",
    displayName: "Streamer",
  },
  machine: {
    id: "machine_7f3c9a",
    name: "Studio PC",
    hostname: "studio-pc",
    platform: "darwin",
  },
  relay: { connected: true, lastEventAt: base + 2 * HOUR + 5 * MINUTE, pending: 0 },
  pairedAt: base - 20 * HOUR,
};

const initialLogs = (): ReadonlyArray<LogEntry> => [
  {
    seq: 1,
    at: base + 2 * HOUR,
    level: "info",
    source: "worker",
    projectId: mainProject.id,
    scriptId: "scripts/redeem-to-scene.ts",
    message: "worker generation 3 started",
  },
  {
    seq: 2,
    at: base + 2 * HOUR + 1_000,
    level: "info",
    source: "connection",
    message: "OBS main connected",
    fields: { url: "ws://127.0.0.1:4455", scenes: 4 },
  },
  {
    seq: 3,
    at: base + 2 * HOUR + 2_000,
    level: "info",
    source: "cloud",
    projectId: mainProject.id,
    scriptId: "scripts/redeem-to-scene.ts",
    message: "subscription created",
    fields: {
      topic: "twitch/channel.channel_points_custom_reward_redemption.add",
      provider: "eventsub",
    },
  },
  {
    seq: 4,
    at: base + 2 * HOUR + 5 * MINUTE,
    level: "info",
    source: "worker",
    projectId: mainProject.id,
    scriptId: "scripts/redeem-to-scene.ts",
    message: 'Redeemed "Hydrate" — switching scene to Game',
    fields: { user: "pixel_pal", reward: "Hydrate" },
  },
  {
    seq: 5,
    at: base + 2 * HOUR + 12 * MINUTE,
    level: "warn",
    source: "agent",
    projectId: mainProject.id,
    scriptId: "scripts/cheer-alert.ts",
    message: "plan requires consent: bits:read, user:write:chat",
  },
  {
    seq: 6,
    at: base + 2 * HOUR + 20 * MINUTE,
    level: "warn",
    source: "connection",
    projectId: altProject.id,
    scriptId: "scripts/scene-rotation.ts",
    message: "obs/secondary is not configured",
  },
  {
    seq: 7,
    at: base + 2 * HOUR + 21 * MINUTE,
    level: "error",
    source: "worker",
    projectId: altProject.id,
    scriptId: "scripts/scene-rotation.ts",
    message: "OBS obs/secondary is not connected",
  },
];

const initialEvents = (): ReadonlyArray<EventRecord> => [
  {
    seq: 1,
    id: "twitch:msg-8f21",
    at: base + 2 * HOUR + 5 * MINUTE,
    direction: "inbound",
    integration: "twitch",
    topic: "twitch/channel.channel_points_custom_reward_redemption.add",
    connectionId: "twitch/broadcaster",
    projectId: mainProject.id,
    scriptId: "scripts/redeem-to-scene.ts",
    payload: {
      reward: { title: "Hydrate" },
      user: { login: "pixel_pal", display_name: "Pixel Pal" },
      redeemed_at: base + 2 * HOUR + 5 * MINUTE,
    },
    stale: false,
    dropped: false,
  },
  {
    seq: 2,
    id: "obs:req-1",
    at: base + 2 * HOUR + 5 * MINUTE + 120,
    direction: "outbound",
    integration: "obs",
    topic: "obs/SetCurrentProgramScene",
    connectionId: "obs/main",
    projectId: mainProject.id,
    scriptId: "scripts/redeem-to-scene.ts",
    request: "SetCurrentProgramScene",
    payload: { sceneName: "Game" },
  },
  {
    seq: 3,
    id: "twitch:msg-90ab",
    at: base + 2 * HOUR + 6 * MINUTE,
    direction: "inbound",
    integration: "twitch",
    topic: "twitch/channel.cheer",
    connectionId: "twitch/broadcaster",
    projectId: mainProject.id,
    scriptId: "scripts/cheer-alert.ts",
    payload: { bits: 500, user: { login: "generous_goblin" } },
    stale: false,
    dropped: true,
  },
  {
    seq: 4,
    id: "fake:tick-12",
    at: base + 2 * HOUR + 7 * MINUTE,
    direction: "inbound",
    integration: "fake",
    topic: "fake/tick",
    connectionId: "fake/main",
    projectId: altProject.id,
    scriptId: "scripts/tick-echo.ts",
    payload: { n: 12 },
    stale: false,
    dropped: false,
  },
];

const initialState = (): MockState => ({
  info: {
    name: "ballast-agent",
    version: "0.1.0-mock",
    apiVersion: AGENT_API_VERSION,
    pid: 4242,
    startedAt: base,
    defaultProjectId: mainProject.id,
    stateDir: "/Users/streamer/.local/state/ballast",
    dataDir: "/Users/streamer/.local/share/ballast",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v24.13.0",
    capabilities: [
      "projects",
      "scripts",
      "connections",
      "cloud",
      "logs",
      "events",
      "consent",
      "graph-preview",
    ],
  },
  projects: new Map([
    [mainProject.id, mainProject],
    [altProject.id, altProject],
  ]),
  projectOrder: [mainProject.id, altProject.id],
  scripts: initialScripts(),
  scriptOrder: [
    scriptKey(mainProject.id, "scripts/redeem-to-scene.ts"),
    scriptKey(mainProject.id, "scripts/cheer-alert.ts"),
    scriptKey(altProject.id, "scripts/tick-echo.ts"),
    scriptKey(altProject.id, "scripts/scene-rotation.ts"),
  ],
  connections: initialConnections(),
  connectionOrder: ["obs/main", "obs/secondary", "twitch/broadcaster", "twitch/bot", "fake/main"],
  consents: new Map([[cheerConsent.id, cheerConsent]]),
  consentOrder: [cheerConsent.id],
  cloud: linkedCloud,
  logs: initialLogs(),
  events: initialEvents(),
  nextLogSeq: 8,
  nextEventSeq: 5,
  nextProjectSeq: 3,
});

const healthOf = (state: MockState): HealthStatus => {
  const connections = state.connectionOrder.flatMap((id) => {
    const connection = state.connections.get(id);
    return connection === undefined ? [] : [connection];
  });
  return {
    ok: true,
    uptimeMs: Math.max(0, Date.now() - state.info.startedAt),
    projects: {
      total: state.projectOrder.length,
      running: 1,
      needsConsent: 0,
      error: 0,
    },
    connections: {
      total: connections.length,
      connected: connections.filter((connection) => connection.status === "connected").length,
      error: connections.filter((connection) => connection.status === "error").length,
    },
    cloud: state.cloud.state,
    lastLogSeq: state.logs.at(-1)?.seq ?? 0,
    lastEventSeq: state.events.at(-1)?.seq ?? 0,
  };
};

const snapshotOf = (state: MockState): ServiceSnapshot => ({
  info: state.info,
  health: healthOf(state),
  projects: state.projectOrder.flatMap((id) => {
    const project = state.projects.get(id);
    return project === undefined ? [] : [project];
  }),
  connections: state.connectionOrder.flatMap((id) => {
    const connection = state.connections.get(id);
    return connection === undefined ? [] : [connection];
  }),
  cloud: state.cloud,
});

const publish = (store: MockStoreService, events: ReadonlyArray<ServiceEvent>) =>
  Effect.forEach(events, (event) => PubSub.publish(store.changes, event), {
    discard: true,
  });

const appendLog = (
  store: MockStoreService,
  input: {
    readonly level: LogEntry["level"];
    readonly source: LogEntry["source"];
    readonly message: string;
    readonly projectId?: string;
    readonly scriptId?: string;
    readonly fields?: LogEntry["fields"];
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(store.state);
    const entry: LogEntry = {
      seq: state.nextLogSeq,
      at: Date.now(),
      level: input.level,
      source: input.source,
      message: input.message,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
    };
    yield* Ref.set(store.state, {
      ...state,
      logs: [...state.logs.slice(-1_999), entry],
      nextLogSeq: state.nextLogSeq + 1,
    });
    yield* PubSub.publish(store.logEntries, entry);
  });

const fail = (error: AgentError): Effect.Effect<never, AgentError> => Effect.fail(error);

const projectScripts = (
  state: MockState,
  projectId: string,
): ReadonlyArray<ScriptDetail> =>
  state.scriptOrder.flatMap((key) => {
    const detail = state.scripts.get(key);
    return detail === undefined || detail.summary.projectId !== projectId
      ? []
      : [detail];
  });

const requireProject = (
  state: MockState,
  projectId: string,
): Effect.Effect<ProjectSummary, AgentError> => {
  const project = state.projects.get(projectId);
  return project === undefined
    ? fail(agentError("not-found", `No project "${projectId}"`))
    : Effect.succeed(project);
};

const requireConnection = (
  state: MockState,
  id: string,
): Effect.Effect<ConnectionSummary, AgentError> => {
  const connection = state.connections.get(id);
  return connection === undefined
    ? fail(agentError("not-found", `No connection "${id}"`))
    : Effect.succeed(connection);
};

const replaceConnection = (
  state: MockState,
  connection: ConnectionSummary,
): MockState => {
  const connections = new Map(state.connections);
  connections.set(connection.id, connection);
  return { ...state, connections };
};

const connectionValues = (
  connection: ConnectionSummary,
  values: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): ConnectionSummary => {
  const fields = new Map(connection.fields.map((field) => [field.key, field]));
  const next = new Map(connection.values.map((value) => [value.key, value]));
  for (const input of values) {
    const field = fields.get(input.key);
    if (field === undefined) continue;
    next.set(input.key, {
      key: input.key,
      isSecret: field.kind === "secret",
      isSet: input.value !== "",
      ...(field.kind === "secret" || input.value === "" ? {} : { value: input.value }),
    });
  }
  return { ...connection, values: [...next.values()] };
};

const validateConnection = (connection: ConnectionSummary): string | undefined => {
  if (connection.mode === "cloud") return undefined;
  for (const field of connection.fields) {
    if (!field.required) continue;
    const value = connection.values.find((entry) => entry.key === field.key);
    if (value === undefined || !value.isSet) return `Set ${field.label} first`;
  }
  return undefined;
};

export const MockAgentStoreLive = Layer.effect(
  MockStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState());
    const changes = yield* PubSub.unbounded<ServiceEvent>();
    const logEntries = yield* PubSub.unbounded<LogEntry>();
    const eventRecords = yield* PubSub.unbounded<EventRecord>();
    return MockStore.of({ state, changes, logEntries, eventRecords });
  }),
);

const handlers = Effect.gen(function* () {
  const store = yield* MockStore;

  const allProjects = (state: MockState): ReadonlyArray<ProjectSummary> =>
    state.projectOrder.flatMap((id) => {
      const project = state.projects.get(id);
      return project === undefined ? [] : [project];
    });

  const requirementsOf = (
    state: MockState,
    projectId: string,
  ): ReadonlyArray<ProjectRequirement> => {
    const requirements: Array<ProjectRequirement> = [];
    for (const detail of projectScripts(state, projectId)) {
      for (const connection of detail.manifest.connections) {
        const instances = [...state.connections.values()].filter(
          (instance) => instance.integration === connection.integration,
        );
        const bound = instances.find((instance) =>
          instance.boundBy.some(
            (ref) => ref.projectId === projectId && ref.slot === connection.slot,
          ),
        );
        requirements.push({
          integration: connection.integration,
          slot: connection.slot,
          location: connection.location,
          ...(bound === undefined ? {} : { boundInstanceId: bound.id }),
          ...(bound === undefined && instances.length === 1 && instances[0] !== undefined
            ? { proposedInstanceId: instances[0].id }
            : {}),
        });
      }
    }
    return requirements;
  };

  const projectDetailOf = (state: MockState, project: ProjectSummary) => ({
    summary: project,
    manifest: emptyProjectManifest(project.id, project.entry ?? "ballast.ts"),
    requirements: requirementsOf(state, project.id),
    units: unitsOf(state, project.id),
  });

  const unitsOf = (
    state: MockState,
    projectId: string,
  ): ReadonlyArray<UnitSummary> =>
    projectScripts(state, projectId).flatMap((detail) => {
      const status = detail.summary.status === "running" ? "active" : "waiting";
      return [
        ...detail.manifest.topics.map(
          (topic): UnitSummary => ({
            kind: "topic",
            name: topic.topic,
            status,
          }),
        ),
        ...detail.manifest.timers.map(
          (timer): UnitSummary => ({
            kind: "timer",
            name: timer.name,
            status,
          }),
        ),
        ...detail.manifest.params.map(
          (param): UnitSummary => ({
            kind: "param",
            name: param.key,
            status: "active",
          }),
        ),
      ];
    });

  return {
    GetServiceInfo: () => Effect.map(Ref.get(store.state), (state) => state.info),
    GetHealth: () => Effect.map(Ref.get(store.state), healthOf),
    ShutdownService: () => Effect.void,
    ReportShellPermission: () => Effect.void,

    ListProjects: () =>
      Effect.map(Ref.get(store.state), (state) => ({
        projects: allProjects(state),
      })),

    GetProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const project = yield* requireProject(state, projectId);
        const entry = project.entry ?? "ballast.ts";
        return {
          summary: project,
          manifest: emptyProjectManifest(projectId, entry),
          requirements: requirementsOf(state, project.id),
          units: unitsOf(state, project.id),
        };
      }),

    PlanProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          return {
            summary: project,
            manifest: emptyProjectManifest(projectId, project.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    StartProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          const next = { ...project, enabled: true, status: "running" as const };
          const projects = new Map(state.projects);
          projects.set(projectId, next);
          yield* Ref.set(store.state, { ...state, projects });
          return {
            summary: next,
            manifest: emptyProjectManifest(projectId, next.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    StopProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          const next = { ...project, enabled: false, status: "stopped" as const };
          const projects = new Map(state.projects);
          projects.set(projectId, next);
          yield* Ref.set(store.state, { ...state, projects });
          return {
            summary: next,
            manifest: emptyProjectManifest(projectId, next.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    RestartProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          return {
            summary: project,
            manifest: emptyProjectManifest(projectId, project.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    SetProjectParam: (request: { readonly projectId: string; readonly key: string; readonly value: ParamValue }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, request.projectId);
          return {
            summary: project,
            manifest: emptyProjectManifest(request.projectId, project.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    SetProjectEnabled: (request: { readonly projectId: string; readonly enabled: boolean }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, request.projectId);
          const next = {
            ...project,
            enabled: request.enabled,
            status: request.enabled ? ("running" as const) : ("stopped" as const),
          };
          const projects = new Map(state.projects);
          projects.set(request.projectId, next);
          yield* Ref.set(store.state, { ...state, projects });
          return {
            summary: next,
            manifest: emptyProjectManifest(request.projectId, next.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
          };
        }),
      ),

    ListProjectFiles: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          const entry = project.entry ?? "ballast.ts";
          return { entry, files: [{ path: entry, kind: "file" as const }] };
        }),
      ),

    ReadProjectFile: (request: { readonly projectId: string; readonly path: string }) =>
      Effect.gen(function* () {
        const content = `// mock source for ${request.path}\n`;
        return {
          path: request.path,
          content,
          sha256: yield* sourceSha256(content),
          updatedAt: Date.now(),
          language: "typescript" as const,
        };
      }),

    GetProjectSource: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          const path = project.entry ?? "ballast.ts";
          const content = `// mock source for ${path}\n`;
          return {
            path,
            content,
            sha256: yield* sourceSha256(content),
            updatedAt: Date.now(),
            language: "typescript" as const,
          };
        }),
      ),

    ListProjectConsents: ({ projectId }: { readonly projectId?: string }) =>
      Effect.map(Ref.get(store.state), (state) => ({
        consents: [...state.consents.values()]
          .filter((consent) => projectId === undefined || consent.projectId === projectId)
          .map(
            (consent): ProjectConsentRequest => ({
              id: consent.id,
              projectId: consent.projectId,
              projectName:
                state.projects.get(consent.projectId)?.name ?? consent.projectId,
              createdAt: consent.createdAt,
              reason: consent.reason,
              summary: consent.summary,
              diff: consent.diff,
              bindings: [],
            }),
          ),
      })),

    ApproveProjectConsent: ({ consentId }: { readonly consentId: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const consent = state.consents.get(consentId);
        if (consent === undefined) {
          return yield* fail(agentError("not-found", `No pending consent "${consentId}"`));
        }
        const project = yield* requireProject(state, consent.projectId);
        return {
          summary: project,
          manifest: emptyProjectManifest(project.id, project.entry ?? "ballast.ts"),
          requirements: requirementsOf(state, project.id),
          units: unitsOf(state, project.id),
              };
      }),

    RejectProjectConsent: (request: { readonly consentId: string; readonly reason?: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const consent = state.consents.get(request.consentId);
          if (consent === undefined) {
            return yield* fail(agentError("not-found", `No pending consent "${request.consentId}"`));
          }
          const project = yield* requireProject(state, consent.projectId);
          return {
            summary: project,
            manifest: emptyProjectManifest(project.id, project.entry ?? "ballast.ts"),
            requirements: requirementsOf(state, project.id),
            units: unitsOf(state, project.id),
                  };
        }),
      ),

    CreateProject: (request: {
      readonly name: string;
      readonly directory?: string;
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const now = Date.now();
        const id = `proj_${state.nextProjectSeq}`;
        const directory =
          request.directory ?? `/Users/streamer/ballast-projects/${request.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
        const project: ProjectSummary = {
          id,
          name: request.name,
          root: directory,
          entry: "ballast.ts",
          enabled: false,
          status: "stopped",
          unitCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        const projects = new Map(state.projects);
        projects.set(id, project);
        yield* Ref.set(store.state, {
          ...state,
          projects,
          projectOrder: [...state.projectOrder, id],
          nextProjectSeq: state.nextProjectSeq + 1,
        });
        return {
          summary: project,
          manifest: emptyProjectManifest(id, "ballast.ts"),
          requirements: [],
          units: [],
        };
      }),

    CheckProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        Effect.gen(function* () {
          const project = yield* requireProject(state, projectId);
          return {
            summary: project,
            ok: true,
            manifest: emptyProjectManifest(projectId, project.entry ?? "ballast.ts"),
            appliedManifest: emptyProjectManifest(projectId, project.entry ?? "ballast.ts"),
            units: unitsOf(state, projectId),
            changes: [],
            requiresConsent: false,
            requirements: requirementsOf(state, projectId),
            missingConnections: requirementsOf(state, projectId).filter(
              (requirement) => requirement.boundInstanceId === undefined,
            ),
            missingScopes: [],
            availableConnections: [...state.connections.values()],
            diagnostics: [],
          };
        }),
      ),

    AddProject: (request: {
      readonly path: string;
      readonly name?: string;
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const root = request.path.trim().replace(/[\\/]+$/, "");
        if (root === "") {
          return yield* fail(agentError("invalid", "A project path is required"));
        }
        if (!root.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(root)) {
          return yield* fail(
            agentError("invalid", `Project path "${request.path}" must be absolute`),
          );
        }
        if (allProjects(state).some((project) => project.root === root)) {
          return yield* fail(
            agentError("conflict", `A project already watches "${root}"`),
          );
        }
        const now = Date.now();
        const folder = root.split(/[\\/]/).at(-1) ?? "Project";
        const project: ProjectSummary = {
          id: `proj_${state.nextProjectSeq}`,
          name: request.name?.trim() || folder,
          root,
          entry: "ballast.ts",
          enabled: false,
          status: "stopped",
          unitCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        const projects = new Map(state.projects);
        projects.set(project.id, project);
        const nextState: MockState = {
          ...state,
          projects,
          projectOrder: [...state.projectOrder, project.id],
          nextProjectSeq: state.nextProjectSeq + 1,
          info: {
            ...state.info,
            defaultProjectId: state.info.defaultProjectId ?? project.id,
          },
        };
        yield* Ref.set(store.state, nextState);
        yield* appendLog(store, {
          level: "info",
          source: "agent",
          message: `project "${project.name}" added`,
          fields: { projectId: project.id, root: project.root },
        });
        yield* publish(store, [
          { _tag: "project", project },
          { _tag: "health", health: healthOf(nextState) },
        ]);
        return {
          summary: project,
          manifest: emptyProjectManifest(project.id, project.entry ?? "ballast.ts"),
          requirements: requirementsOf(state, project.id),
          units: unitsOf(state, project.id),
        };
      }),

    RemoveProject: ({ projectId }: { readonly projectId: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const project = yield* requireProject(state, projectId);
        const removed = projectScripts(state, projectId);
        const scripts = new Map(state.scripts);
        for (const detail of removed) {
          scripts.delete(scriptKey(detail.summary.projectId, detail.summary.id));
        }
        const projects = new Map(state.projects);
        projects.delete(projectId);
        const consents = new Map(
          [...state.consents].filter(([, consent]) => consent.projectId !== projectId),
        );
        const connections = new Map(
          [...state.connections].map(([id, connection]) => [
            id,
            {
              ...connection,
              boundBy: connection.boundBy.filter((ref) => ref.projectId !== projectId),
            },
          ]),
        );
        const nextDefault = state.projectOrder.find((id) => id !== projectId);
        const nextState: MockState = {
          ...state,
          projects,
          projectOrder: state.projectOrder.filter((id) => id !== projectId),
          scripts,
          scriptOrder: state.scriptOrder.filter(
            (key) => !removed.some((detail) => scriptKey(detail.summary.projectId, detail.summary.id) === key),
          ),
          consents,
          consentOrder: state.consentOrder.filter((id) => consents.has(id)),
          connections,
          info:
            state.info.defaultProjectId === projectId && nextDefault !== undefined
              ? { ...state.info, defaultProjectId: nextDefault }
              : state.info,
        };
        yield* Ref.set(store.state, nextState);
        yield* appendLog(store, {
          level: "info",
          source: "agent",
          message: `project "${project.name}" removed`,
          fields: { projectId },
        });
        yield* publish(store, [
          { _tag: "project-removed", projectId },
          { _tag: "health", health: healthOf(nextState) },
        ]);
        return undefined;
      }),

    ListTimers: () => Effect.succeed({ timers: [] }),
    CancelTimer: () => Effect.succeed({ cancelled: false }),

    ListIntegrations: () =>
      Effect.succeed({ integrations: connectionIntegrations }),

    ListConnections: () =>
      Effect.map(Ref.get(store.state), (state) => ({
        connections: state.connectionOrder.flatMap((id) => {
          const connection = state.connections.get(id);
          return connection === undefined ? [] : [connection];
        }),
      })),

    CreateConnection: (request: {
      readonly integration: string;
      readonly label: string;
      readonly config: Readonly<Record<string, string>>;
      readonly mode?: ConnectionSummary["mode"];
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const template = [...state.connections.values()].find(
          (connection) => connection.integration === request.integration,
        );
        if (template === undefined) {
          return yield* fail(agentError("invalid", `Unknown integration "${request.integration}"`));
        }
        const id = `conn_mock_${state.connections.size + 1}`;
        const values = template.fields.map((field) => ({
          key: field.key,
          isSecret: field.kind === "secret",
          isSet: request.config[field.key] !== undefined,
          ...(field.kind === "secret" || request.config[field.key] === undefined
            ? {}
            : { value: request.config[field.key] }),
        }));
        const connection: ConnectionSummary = {
          ...template,
          id,
          label: request.label,
          mode: request.mode ?? "auto",
          status: "disconnected",
          values,
          boundBy: [],
        };
        const connections = new Map(state.connections);
        connections.set(id, connection);
        yield* Ref.set(store.state, { ...state, connections });
        return connection;
      }),

    UpdateConnection: (request: {
      readonly id: string;
      readonly label?: string;
      readonly config?: Readonly<Record<string, string>>;
      readonly mode?: ConnectionSummary["mode"];
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, request.id);
        const values = connection.values.map((value) => {
          const next = request.config?.[value.key];
          if (next === undefined) return value;
          return value.isSecret
            ? { ...value, isSet: next !== "" }
            : { ...value, value: next, isSet: next !== "" };
        });
        const next: ConnectionSummary = {
          ...connection,
          label: request.label ?? connection.label,
          mode: request.mode ?? connection.mode,
          values,
        };
        yield* Ref.set(store.state, replaceConnection(state, next));
        return next;
      }),

    DeleteConnection: ({ id }: { readonly id: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, id);
        if (connection.boundBy.length > 0) {
          return yield* fail(
            agentError(
              "conflict",
              `Connection "${connection.label}" is bound to a project slot; unbind it first`,
            ),
          );
        }
        const connections = new Map(state.connections);
        connections.delete(id);
        yield* Ref.set(store.state, { ...state, connections });
      }),

    SetProjectBinding: (request: {
      readonly projectId: string;
      readonly integration: string;
      readonly slot: string;
      readonly instanceId: string | null;
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const project = yield* requireProject(state, request.projectId);
        const connections = new Map(
          [...state.connections].map(([id, connection]) => [
            id,
            {
              ...connection,
              boundBy: connection.boundBy.filter(
                (ref) => !(ref.projectId === request.projectId && ref.slot === request.slot),
              ),
            },
          ]),
        );
        if (request.instanceId !== null) {
          const connection = connections.get(request.instanceId);
          if (connection === undefined) {
            return yield* fail(agentError("not-found", `No connection "${request.instanceId}"`));
          }
          if (connection.integration !== request.integration) {
            return yield* fail(agentError("invalid", "Connection integration does not match"));
          }
          connections.set(request.instanceId, {
            ...connection,
            boundBy: [...connection.boundBy, { projectId: request.projectId, slot: request.slot }],
          });
        }
        const nextState = { ...state, connections };
        yield* Ref.set(store.state, nextState);
        return projectDetailOf(nextState, project);
      }),

    GetConnection: ({ connectionId }: { readonly connectionId: string }) =>
      Effect.flatMap(Ref.get(store.state), (state) =>
        requireConnection(state, connectionId),
      ),

    ConfigureConnection: (request: {
      readonly connectionId: string;
      readonly values: ReadonlyArray<{ readonly key: string; readonly value: string }>;
      readonly mode?: ConnectionSummary["mode"];
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, request.connectionId);
        const unknown = request.values.find(
          (value) => !connection.fields.some((field) => field.key === value.key),
        );
        if (unknown !== undefined) {
          return yield* fail(
            agentError(
              "invalid",
              `${connection.title} has no setting "${unknown.key}"; expected ${connection.fields
                .map((field) => field.key)
                .join(", ")}`,
            ),
          );
        }
        const configured = connectionValues(connection, request.values);
        const next: ConnectionSummary = {
          ...configured,
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          status:
            configured.status === "unconfigured" ? "disconnected" : configured.status,
        };
        yield* Ref.set(store.state, replaceConnection(state, next));
        yield* publish(store, [{ _tag: "connection", connection: next }]);
        return next;
      }),

    ConnectConnection: ({ connectionId }: { readonly connectionId: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, connectionId);
        const invalid = validateConnection(connection);
        if (invalid !== undefined) {
          return yield* fail(
            agentError("invalid", `Cannot connect ${connection.title}: ${invalid}`),
          );
        }
        const now = Date.now();
        const needsAuth = connection.scopes.missing.length > 0;
        const next: ConnectionSummary = {
          ...connection,
          status: needsAuth ? "reauth-required" : "connected",
          lastConnectedAt: now,
          requiresAuth: needsAuth,
          ...(needsAuth
            ? {
                lastError: `Missing scopes: ${connection.scopes.missing.join(", ")}`,
              }
            : { detail: connection.detail ?? "Connected" }),
        };
        yield* Ref.set(store.state, replaceConnection(state, next));
        yield* appendLog(store, {
          level: needsAuth ? "warn" : "info",
          source: "connection",
          message: needsAuth
            ? `${next.title} ${next.label} needs authorization: ${connection.scopes.missing.join(", ")}`
            : `${next.title} ${next.label} connected`,
        });
        yield* publish(store, [
          { _tag: "connection", connection: next },
          { _tag: "health", health: healthOf(yield* Ref.get(store.state)) },
        ]);
        return next;
      }),

    DisconnectConnection: ({ connectionId }: { readonly connectionId: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, connectionId);
        const next: ConnectionSummary = {
          ...connection,
          status: "disconnected",
          requiresAuth: connection.scopes.missing.length > 0,
        };
        yield* Ref.set(store.state, replaceConnection(state, next));
        yield* appendLog(store, {
          level: "info",
          source: "connection",
          message: `${next.title} ${next.label} disconnected`,
        });
        yield* publish(store, [
          { _tag: "connection", connection: next },
          { _tag: "health", health: healthOf(yield* Ref.get(store.state)) },
        ]);
        return next;
      }),

    StartConnectionAuth: (request: {
      readonly connectionId: string;
      readonly mode?: ConnectionSummary["mode"];
      readonly scopes?: ReadonlyArray<string>;
    }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const connection = yield* requireConnection(state, request.connectionId);
        if (connection.integration === "obs") {
          return {
            _tag: "none" as const,
            message:
              "OBS uses a WebSocket URL and password. Set them in Connections, then connect.",
          };
        }
        if (connection.integration === "fake") {
          return {
            _tag: "none" as const,
            message: "The fake integration has no authentication.",
          };
        }
        return {
          _tag: "browser" as const,
          url: `https://cloud.ballast.stream/oauth/twitch?connection=${encodeURIComponent(
            connection.id,
          )}`,
          expiresAt: Date.now() + 10 * MINUTE,
        };
      }),

    GetCloudStatus: () => Effect.map(Ref.get(store.state), (state) => state.cloud),

    BeginCloudPairing: ({ machineName }: { readonly machineName: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const cloud: CloudStatus = {
          state: "linking",
          cloudUrl: "https://cloud.ballast.stream",
          machine: {
            id: "machine_pending",
            name: machineName,
            platform: "darwin",
          },
        };
        yield* Ref.set(store.state, { ...state, cloud });
        yield* publish(store, [{ _tag: "cloud", cloud }]);
        return {
          url: "https://cloud.ballast.stream/pair",
          code: "BCDF-2345",
          expiresAt: Date.now() + 10 * MINUTE,
          instructions:
            "Sign in with Twitch in your browser, then confirm the code shown here.",
        };
      }),

    PairCloud: ({ machineName }: { readonly code: string; readonly machineName: string }) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const cloud: CloudStatus = {
          state: "linked",
          cloudUrl: "https://cloud.ballast.stream",
          account: {
            id: "44322889",
            login: "streamer",
            displayName: "Streamer",
          },
          machine: {
            id: "machine_7f3c9a",
            name: machineName,
            hostname: "studio-pc",
            platform: "darwin",
          },
          relay: { connected: true, pending: 0 },
          pairedAt: Date.now(),
        };
        yield* Ref.set(store.state, { ...state, cloud });
        yield* appendLog(store, {
          level: "info",
          source: "cloud",
          message: `paired as ${cloud.account?.login ?? "unknown"}`,
        });
        yield* publish(store, [{ _tag: "cloud", cloud }]);
        return cloud;
      }),

    UnpairCloud: () =>
      Effect.gen(function* () {
        const state = yield* Ref.get(store.state);
        const cloud = cloudUnlinked();
        yield* Ref.set(store.state, { ...state, cloud });
        yield* appendLog(store, {
          level: "info",
          source: "cloud",
          message: "cloud pairing removed",
        });
        yield* publish(store, [{ _tag: "cloud", cloud }]);
        return cloud;
      }),

    StreamLogs: (request: {
      readonly projectId?: string;
      readonly scriptId?: string;
      readonly afterSeq?: number;
      readonly levels?: ReadonlyArray<LogEntry["level"]>;
      readonly limit?: number;
    }) =>
      Stream.unwrap(
        Effect.map(Ref.get(store.state), (state) => {
          const matches = (entry: LogEntry): boolean =>
            (request.projectId === undefined || entry.projectId === request.projectId) &&
            (request.scriptId === undefined || entry.scriptId === request.scriptId) &&
            (request.levels === undefined || request.levels.includes(entry.level));
          const buffered = state.logs.filter(
            (entry) => entry.seq > (request.afterSeq ?? 0) && matches(entry),
          );
          const replay =
            request.limit === undefined ? buffered : buffered.slice(-request.limit);
          return Stream.concat(
            Stream.fromIterable(replay),
            Stream.fromPubSub(store.logEntries).pipe(Stream.filter(matches)),
          );
        }),
      ),

    StreamEvents: (request: {
      readonly projectId?: string;
      readonly scriptId?: string;
      readonly integration?: string;
      readonly topic?: string;
      readonly afterSeq?: number;
      readonly limit?: number;
    }) =>
      Stream.unwrap(
        Effect.map(Ref.get(store.state), (state) => {
          const matches = (record: EventRecord): boolean =>
            (request.projectId === undefined || record.projectId === request.projectId) &&
            (request.scriptId === undefined || record.scriptId === request.scriptId) &&
            (request.integration === undefined ||
              record.integration === request.integration) &&
            (request.topic === undefined || record.topic === request.topic);
          const buffered = state.events.filter(
            (record) => record.seq > (request.afterSeq ?? 0) && matches(record),
          );
          const replay =
            request.limit === undefined ? buffered : buffered.slice(-request.limit);
          return Stream.concat(
            Stream.fromIterable(replay),
            Stream.fromPubSub(store.eventRecords).pipe(Stream.filter(matches)),
          );
        }),
      ),

    WatchService: () =>
      Stream.unwrap(
        Effect.map(Ref.get(store.state), (state) =>
          Stream.concat(
            Stream.fromIterable<ServiceEvent>([
              { _tag: "snapshot", snapshot: snapshotOf(state) },
            ]),
            Stream.fromPubSub(store.changes),
          ),
        ),
      ),
  };
});
export const MockAgentRpcs = AgentRpcs.toLayer(handlers);

export const MockAgentLayer = MockAgentRpcs.pipe(Layer.provide(MockAgentStoreLive));
