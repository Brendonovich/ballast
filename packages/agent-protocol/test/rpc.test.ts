import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcTest } from "effect/rpc";

import { AgentRpcs, ConnectionSummary, MockAgentLayer, ProjectDetail } from "../src/index.ts";

const client = RpcTest.makeClient(AgentRpcs).pipe(
  Effect.provide(MockAgentLayer),
);

const main = "proj_main";
const alt = "proj_alt";

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

      const projects = yield* agent.ListProjects();
      expect(projects.projects.map((project) => project.id)).toEqual([main, alt]);
      expect(projects.projects.map((project) => project.name)).toEqual([
        "Main Channel",
        "Second Channel",
      ]);
    }),
  );

  it.effect("returns a project's detail", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const project = yield* agent.GetProject({ projectId: alt });
      expect(project.summary.name).toBe("Second Channel");
      expect(project.requirements.length).toBeGreaterThan(0);
      expect(project.units.length).toBeGreaterThan(0);

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
      expect(added.units).toEqual([]);
      expect((yield* agent.ListProjects()).projects).toHaveLength(3);

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

  it.effect("streams project logs and events", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const mainLogs = yield* agent
        .StreamLogs({ projectId: main })
        .pipe(Stream.take(2), Stream.runCollect);
      expect(mainLogs).toHaveLength(2);
      expect(mainLogs.every((entry) => entry.projectId === main)).toBe(true);

      const altEvents = yield* agent
        .StreamEvents({ projectId: alt })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(altEvents[0]?.projectId).toBe(alt);
    }),
  );

  it.effect("queries durable subscription history through the service", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const listed = yield* agent.ListEventHistorySubscriptions({ projectId: main });
      const name = listed.subscriptions[0]?.name;
      if (name === undefined) throw new Error("mock history subscription missing");

      const page = yield* agent.QueryEventHistory({
        projectId: main,
        subscription: name,
        limit: 1,
      });
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.fingerprint).toBe("mock");
      expect(page.entries[0]?.event).toMatchObject({
        reward: { title: "Hydrate" },
      });

      const filtered = yield* agent.ListEventHistorySubscriptions({
        projectId: main,
        subscription: name,
      });
      expect(filtered.subscriptions.map((entry) => entry.name)).toEqual([name]);

      const missing = yield* agent
        .QueryEventHistory({ projectId: "nope", subscription: name })
        .pipe(Effect.exit);
      expect(Exit.isFailure(missing)).toBe(true);
    }),
  );

  it.effect("watches the initial service snapshot", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const watch = yield* agent.WatchService({}, { asQueue: true });
      const snapshot = yield* Queue.take(watch);
      expect(snapshot._tag).toBe("snapshot");
      if (snapshot._tag === "snapshot") {
        expect(snapshot.snapshot.projects).toHaveLength(2);
        expect(snapshot.snapshot.connections.length).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("round-trips project details and connections through JSON", () =>
    Effect.gen(function* () {
      const agent = yield* client;

      const detail = yield* agent.GetProject({ projectId: main });
      const encodedDetail = Schema.encodeSync(Schema.fromJsonString(ProjectDetail))(detail);
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ProjectDetail))(encodedDetail)).toEqual(
        detail,
      );

      const [connection] = (yield* agent.ListConnections()).connections;
      if (connection === undefined) return;
      const encodedConnection = Schema.encodeSync(
        Schema.fromJsonString(ConnectionSummary),
      )(connection);
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionSummary))(encodedConnection),
      ).toEqual(connection);
    }),
  );
});
