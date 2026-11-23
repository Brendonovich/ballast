import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcTest } from "effect/rpc";

import {
  AgentRpcs,
  ConnectionSummary,
  MockAgentLayer,
  ScriptDetail,
} from "../src/index.ts";

const client = RpcTest.makeClient(AgentRpcs).pipe(
  Effect.provide(MockAgentLayer),
);

const main = "proj_main";
const alt = "proj_alt";
const redeem = "scripts/redeem-to-scene.ts";
const cheer = "scripts/cheer-alert.ts";
const tick = "scripts/tick-echo.ts";
const rotation = "scripts/scene-rotation.ts";

const mainScript = { projectId: main, scriptId: redeem };
const altTick = { projectId: alt, scriptId: tick };

describe("@ballast/agent-protocol RPC group", () => {
  it.effect("serves service info, projects and a realistic workspace", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const info = yield* agent.GetServiceInfo();
      expect(info.name).toBe("ballast-agent");
      expect(info.apiVersion).toBe(1);
      expect(info.defaultProjectId).toBe(main);
      expect(info.dataDir).toContain("ballast");

      const health = yield* agent.GetHealth();
      expect(health.ok).toBe(true);
      expect(health.projects.total).toBe(2);
      expect(health.scripts.total).toBe(4);
      expect(health.scripts.running).toBe(1);
      expect(health.cloud).toBe("linked");

      const projects = yield* agent.ListProjects();
      expect(projects.projects.map((project) => project.id)).toEqual([main, alt]);
      expect(projects.projects.map((project) => project.name)).toEqual([
        "Main Channel",
        "Second Channel",
      ]);

      const allScripts = yield* agent.ListScripts({});
      expect(allScripts.scripts.map((script) => script.projectId)).toEqual([
        main,
        main,
        alt,
        alt,
      ]);

      const mainScripts = yield* agent.ListScripts({ projectId: main });
      expect(mainScripts.scripts.map((script) => script.id)).toEqual([redeem, cheer]);
      expect(
        mainScripts.scripts.find((script) => script.id === cheer)?.status,
      ).toBe("needs-consent");
      expect(
        mainScripts.scripts.find((script) => script.id === cheer)?.enabled,
      ).toBe(false);
    }),
  );

  it.effect("returns a project's detail", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const project = yield* agent.GetProject({ projectId: alt });
      expect(project.summary.name).toBe("Second Channel");
      expect(project.summary.scriptCount).toBe(2);
      expect(project.scripts.map((script) => script.id)).toEqual([tick, rotation]);

      const missing = yield* agent.GetProject({ projectId: "nope" }).pipe(Effect.exit);
      expect(Exit.isFailure(missing)).toBe(true);
    }),
  );

  it.effect("adds and removes projects without touching their files", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const added = yield* agent.AddProject({
        path: "/Users/streamer/Ballast/guest",
        name: "Guest",
      });
      expect(added.summary.name).toBe("Guest");
      expect(added.summary.scriptCount).toBe(0);
      expect((yield* agent.ListProjects()).projects).toHaveLength(3);
      expect((yield* agent.ListScripts({ projectId: added.summary.id })).scripts).toEqual(
        [],
      );

      const duplicate = yield* agent
        .AddProject({ path: "/Users/streamer/Ballast/guest" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(duplicate)).toBe(true);

      const relative = yield* agent
        .AddProject({ path: "guest" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(relative)).toBe(true);

      yield* agent.RemoveProject({ projectId: added.summary.id });
      expect((yield* agent.ListProjects()).projects.map((p) => p.id)).toEqual([
        main,
        alt,
      ]);
    }),
  );

  it.effect("lists integration descriptors before any instance exists", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const listed = yield* agent.ListIntegrations();
      expect(listed.integrations.map((entry) => entry.integration)).toEqual([
        "obs",
        "twitch",
        "fake",
        "vts",
        "keyboard",
        "midi",
        "websocket",
        "http",
      ]);
      const obs = listed.integrations.find((entry) => entry.integration === "obs");
      expect(obs?.location).toBe("local");
      expect(obs?.fields.map((field) => field.key)).toEqual(["url", "password"]);
      expect(obs?.fields.find((field) => field.key === "password")?.description).toContain(
        "0600",
      );
      const twitch = listed.integrations.find((entry) => entry.integration === "twitch");
      expect(twitch?.requiresAuth).toBe(true);
      expect(twitch?.modes).toEqual(["auto", "local-app", "cloud"]);
      expect(twitch?.fields.map((field) => field.key)).toEqual([
        "clientId",
        "clientSecret",
        "connection",
      ]);
      expect(listed.integrations.find((entry) => entry.integration === "http")?.modes).toContain(
        "cloud",
      );
    }),
  );

  it.effect("removing a project drops its scripts and connection usage", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      yield* agent.RemoveProject({ projectId: alt });

      expect((yield* agent.ListProjects()).projects.map((p) => p.id)).toEqual([main]);
      expect((yield* agent.ListScripts({})).scripts.map((script) => script.projectId)).toEqual([
        main,
        main,
      ]);
      const removedScript = yield* agent.GetScript(altTick).pipe(Effect.exit);
      expect(Exit.isFailure(removedScript)).toBe(true);

      const obs = yield* agent.GetConnection({ connectionId: "obs/main" });
      expect(obs.boundBy).toEqual([{ projectId: main, slot: "main" }]);
    }),
  );

  it.effect("returns a script's manifest, params and pending consent", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const detail = yield* agent.GetScript(mainScript);
      expect(detail.summary.projectId).toBe(main);
      expect(detail.summary.status).toBe("running");
      expect(detail.manifest.params.map((param) => param.key)).toEqual([
        "rewardTitle",
        "scene",
        "holdSeconds",
      ]);
      expect(detail.manifest.topics[0]?.topic).toBe(
        "twitch/channel.channel_points_custom_reward_redemption.add",
      );
      expect(detail.manifest.connections[0]?.connectionId).toBe(
        "twitch/broadcaster",
      );
      expect(detail.pendingConsent).toBeUndefined();

      const pending = yield* agent.GetScript({ projectId: main, scriptId: cheer });
      expect(pending.pendingConsent?.id).toBe("consent-cheer");
      expect(pending.pendingConsent?.projectId).toBe(main);
      expect(pending.pendingConsent?.diff.added.scopes).toEqual([
        "bits:read",
        "user:write:chat",
      ]);

      const wrongProject = yield* agent
        .GetScript({ projectId: alt, scriptId: redeem })
        .pipe(Effect.exit);
      expect(Exit.isFailure(wrongProject)).toBe(true);
    }),
  );

  it.effect("returns a read-only script source with a content hash", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const source = yield* agent.GetScriptSource(mainScript);
      expect(source.path).toBe(redeem);
      expect(source.language).toBe("typescript");
      expect(source.content).toContain("Effect.gen");
      expect(source.content).toContain("ChannelPointsRedemption.subscribe");
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.updatedAt).toBe((yield* agent.GetScript(mainScript)).summary.updatedAt);

      const altSource = yield* agent.GetScriptSource(altTick);
      expect(altSource.path).toBe(tick);
      expect(altSource.content).toContain("Fake.Tick.subscribe");
      expect(altSource.sha256).not.toBe(source.sha256);

      const missing = yield* agent
        .GetScriptSource({ projectId: main, scriptId: "scripts/nope.ts" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(missing)).toBe(true);
    }),
  );

  it.effect("sets params, validates them and bumps the generation", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const updated = yield* agent.SetScriptParam({
        ...mainScript,
        key: "scene",
        value: "BRB",
      });
      expect(
        updated.manifest.params.find((param) => param.key === "scene")?.value,
      ).toBe("BRB");
      expect(updated.summary.generation).toBe(4);

      const rejected = yield* agent
        .SetScriptParam({ ...mainScript, key: "scene", value: 42 })
        .pipe(Effect.exit);
      expect(Exit.isFailure(rejected)).toBe(true);

      const missing = yield* agent
        .SetScriptParam({ ...mainScript, key: "nope", value: "x" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(missing)).toBe(true);
    }),
  );

  it.effect("starts, stops and resumes scripts by explicit action", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const disabled = yield* agent.SetScriptEnabled({ ...altTick, enabled: false });
      expect(disabled.summary.enabled).toBe(false);

      const started = yield* agent.StartScript(altTick);
      expect(started.summary.status).toBe("running");
      expect(started.summary.enabled).toBe(true);
      expect(started.summary.generation).toBe(2);
      expect(started.appliedManifest).toEqual(started.manifest);

      const stopped = yield* agent.StopScript(altTick);
      expect(stopped.summary.status).toBe("stopped");
      expect(stopped.summary.enabled).toBe(false);

      const resumed = yield* agent.SetScriptEnabled({ ...altTick, enabled: true });
      expect(resumed.summary.status).toBe("running");
      expect(resumed.summary.enabled).toBe(true);

      const blocked = yield* agent
        .StartScript({ projectId: main, scriptId: cheer })
        .pipe(Effect.exit);
      expect(Exit.isFailure(blocked)).toBe(true);

      const restarted = yield* agent.RestartScript(altTick);
      expect(restarted.summary.status).toBe("running");
      expect(restarted.summary.generation).toBe(4);
      expect(restarted.summary.enabled).toBe(true);
    }),
  );

  it.effect("approves and rejects pending consent", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const before = yield* agent.ListConsents({});
      expect(before.consents.map((consent) => consent.id)).toEqual([
        "consent-cheer",
      ]);
      expect((yield* agent.ListConsents({ projectId: alt })).consents).toEqual([]);

      const approved = yield* agent.ApproveConsent({ consentId: "consent-cheer" });
      expect(approved.summary.status).toBe("running");
      expect(approved.summary.enabled).toBe(true);
      expect(approved.pendingConsent).toBeUndefined();
      expect(approved.appliedManifest).toEqual(approved.manifest);

      const after = yield* agent.ListConsents({});
      expect(after.consents).toEqual([]);
    }),
  );

  it.effect("configures, connects and authorizes service-wide connections", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const listed = yield* agent.ListConnections();
      expect(listed.connections.map((connection) => connection.id)).toContain(
        "obs/secondary",
      );
      const broadcaster = listed.connections.find(
        (connection) => connection.id === "twitch/broadcaster",
      );
      expect(broadcaster?.boundBy).toEqual([
        { projectId: main, slot: "broadcaster" },
      ]);

      const configured = yield* agent.ConfigureConnection({
        connectionId: "obs/secondary",
        values: [
          { key: "url", value: "ws://192.168.1.20:4455" },
          { key: "password", value: "hunter2" },
        ],
      });
      expect(configured.status).toBe("disconnected");
      expect(
        configured.values.find((value) => value.key === "url")?.value,
      ).toBe("ws://192.168.1.20:4455");
      expect(
        configured.values.find((value) => value.key === "password"),
      ).toEqual({ key: "password", isSecret: true, isSet: true });

      const connected = yield* agent.ConnectConnection({
        connectionId: "obs/secondary",
      });
      expect(connected.status).toBe("connected");

      const auth = yield* agent.StartConnectionAuth({
        connectionId: "twitch/bot",
      });
      expect(auth._tag).toBe("browser");
      if (auth._tag === "browser") {
        expect(auth.url).toContain("oauth/twitch");
        expect(auth.expiresAt).toBeGreaterThan(Date.now());
      }

      const unknownField = yield* agent
        .ConfigureConnection({
          connectionId: "obs/secondary",
          values: [{ key: "nope", value: "x" }],
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(unknownField)).toBe(true);
    }),
  );

  it.effect("pairs and unpairs the cloud", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      expect((yield* agent.GetCloudStatus()).state).toBe("linked");

      const unlinked = yield* agent.UnpairCloud();
      expect(unlinked.state).toBe("unlinked");

      const session = yield* agent.BeginCloudPairing({ machineName: "Test PC" });
      expect(session.code ?? "").toMatch(/^[A-Z0-9-]+$/);
      expect((yield* agent.GetCloudStatus()).state).toBe("linking");

      const paired = yield* agent.PairCloud({
        code: session.code ?? "",
        machineName: "Test PC",
      });
      expect(paired.state).toBe("linked");
      expect(paired.account?.login).toBe("streamer");
      expect(paired.machine?.name).toBe("Test PC");
    }),
  );

  it.effect("streams buffered and live logs scoped by project", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const mainLogs = yield* agent
        .StreamLogs({ projectId: main })
        .pipe(Stream.take(2), Stream.runCollect);
      expect(mainLogs).toHaveLength(2);
      expect(mainLogs.every((entry) => entry.projectId === main)).toBe(true);

      const altLogs = yield* agent
        .StreamLogs({ projectId: alt })
        .pipe(Stream.take(2), Stream.runCollect);
      expect(altLogs.map((entry) => entry.scriptId)).toEqual([
        rotation,
        rotation,
      ]);

      const queue = yield* agent.StreamLogs(
        { projectId: alt, scriptId: tick },
        { asQueue: true },
      );
      yield* agent.StartScript(altTick);
      const live = yield* Queue.take(queue);
      expect(live.projectId).toBe(alt);
      expect(live.scriptId).toBe(tick);
      expect(live.message).toContain("started generation");
    }),
  );

  it.effect("streams events and watches service state across projects", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const events = yield* agent
        .StreamEvents({ projectId: alt })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(events[0]?.projectId).toBe(alt);
      expect(events[0]?.scriptId).toBe(tick);

      const watch = yield* agent.WatchService({}, { asQueue: true });
      const snapshot = yield* Queue.take(watch);
      expect(snapshot._tag).toBe("snapshot");
      if (snapshot._tag === "snapshot") {
        expect(snapshot.snapshot.projects).toHaveLength(2);
        expect(snapshot.snapshot.scripts).toHaveLength(4);
        expect(snapshot.snapshot.consents).toHaveLength(1);
      }

      yield* agent.StopScript(mainScript);
      const change = yield* Queue.take(watch);
      expect(change._tag).toBe("script");
      if (change._tag === "script") {
        expect(change.script.projectId).toBe(main);
        expect(change.script.id).toBe(redeem);
        expect(change.script.status).toBe("stopped");
        expect(change.script.enabled).toBe(false);
      }
    }),
  );

  it.effect("round-trips script details and connections through JSON", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const detail = yield* agent.GetScript(mainScript);
      const encodedDetail = Schema.encodeSync(Schema.fromJsonString(ScriptDetail))(detail);
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ScriptDetail))(encodedDetail)).toEqual(
        detail,
      );

      const connection = yield* agent.GetConnection({ connectionId: "twitch/bot" });
      const encodedConnection = Schema.encodeSync(Schema.fromJsonString(ConnectionSummary))(
        connection,
      );
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionSummary))(encodedConnection),
      ).toEqual(connection);
    }),
  );
});
