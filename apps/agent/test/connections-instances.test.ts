import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  DEFAULT_TWITCH_CALLBACK_PORT,
  type ConnectionSummary,
  type ProjectDetail,
} from "@ballast/agent-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";
import { startMockObsServer } from "./mock-obs-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const source = [
  'import * as OBS from "@ballast/module-obs";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const obs = yield* OBS.Connection("main");',
  '  yield* OBS.CurrentProgramSceneChanged.subscribe("scene", obs, (event) =>',
  '    Effect.log("SCENE " + event.sceneName),',
  "  );",
  "});",
  "",
].join("\n");

const waitFor = <A, E>(
  label: string,
  read: () => Effect.Effect<A | undefined, E>,
  timeoutMs = 30_000,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* read();
      if (value !== undefined) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for " + label));
  });

const asError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return new Error(message);
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
};

const call = <A, E>(
  root: string,
  use: (client: LiveAgentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  withAgentClient(use, {
    BALLAST_STATE_DIR: join(root, "state"),
    BALLAST_DATA_DIR: join(root, "data"),
  }).pipe(
    Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
    Effect.mapError(asError));

interface Service {
  readonly child: ChildProcess;
  readonly stop: () => Effect.Effect<void>;
}

const startService = (root: string): Effect.Effect<Service, Error> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => rm(join(root, "state", "service.json"), { force: true }));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "serve", "--port", "0"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          BALLAST_STATE_DIR: join(root, "state"),
          BALLAST_DATA_DIR: join(root, "data"),
          BALLAST_LOG_DIR: join(root, "logs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Drain the service's pipes; an unread pipe eventually blocks the child.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    yield* waitFor("service", () =>
      Effect.promise(async () => {
        const registration = await Effect.runPromise(readServiceRegistration(join(root, "state")).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)));
        return registration?.pid === child.pid ? registration : undefined;
      }),
    );
    const stop = () =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          yield* Effect.sleep("50 millis");
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        yield* Effect.sleep("100 millis");
      });
    return { child, stop };
  });

const makeProject = (root: string, name: string, content = source): Effect.Effect<string> =>
  Effect.gen(function* () {
    const project = join(root, name);
    yield* Effect.promise(async () => {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "ballast.ts"), content, "utf8");
    });
    return project;
  });

const paramsSource = [
  'import * as Ballast from "@ballast/core";',
  'import * as OBS from "@ballast/module-obs";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const obs = yield* OBS.Connection("main");',
  '  const scenes = yield* Ballast.Param.strings("scenes", {',
  '    title: "Scenes",',
  '    description: "Pick one or more OBS scenes",',
  '    options: OBS.scenes(obs),',
  '    default: ["Scene 1"],',
  "  });",
  '  const greeting = yield* Ballast.Param.string("greeting", {',
  '    description: "What to say on air",',
  '    default: "Hello",',
  "  });",
  '  const labels = yield* Ballast.Param.strings("labels");',
  '  const enabled = yield* Ballast.Param.boolean("enabled");',
  '  const mode = yield* Ballast.Param.enum("mode", ["a", "b"]);',
  '  yield* OBS.CurrentProgramSceneChanged.subscribe("scene", obs, () =>',
  '    Effect.gen(function* () {',
  '      yield* Effect.log("SCENES " + (yield* scenes).join(",") + " " + (yield* greeting) + " " + (yield* labels).join("|") + " " + String(yield* enabled) + " " + (yield* mode));',
  "    }),",
  "  );",
  "});",
  "",
].join("\n");

const waitForProject = (
  root: string,
  projectId: string,
  predicate: (detail: ProjectDetail) => boolean,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    let latest: ProjectDetail | undefined;
    while (Date.now() < deadline) {
      latest = yield* call(root, (client) => client.GetProject({ projectId }));
      if (predicate(latest)) return latest;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(
      new Error(
        "Timed out waiting for project state; last=" +
          JSON.stringify(latest?.summary ?? null),
      ),
    );
  });

const approve = (client: LiveAgentClient, projectId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const consents = yield* client.ListProjectConsents({ projectId });
      const consent = consents.consents[0];
      if (consent !== undefined) {
        yield* client.ApproveProjectConsent({ consentId: consent.id });
        return;
      }
      yield* Effect.sleep("100 millis");
    }
  });

const freePorts = (count: number): Effect.Effect<ReadonlyArray<number>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const servers = await Promise.all(
        Array.from(
          { length: count },
          () =>
            new Promise<{ readonly server: Server; readonly port: number }>((resolve, reject) => {
              const server = createServer();
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (address === null || typeof address === "string") {
                  server.close();
                  reject(new Error("no ephemeral port"));
                  return;
                }
                resolve({ server, port: address.port });
              });
            }),
        ),
      );
      await Promise.all(
        servers.map(
          (entry) => new Promise<void>((resolve) => entry.server.close(() => resolve())),
        ),
      );
      return servers.map((entry) => entry.port);
    },
    catch: (cause) => new Error(String(cause)),
  });

const holdPort = (port: number): Effect.Effect<Server, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server));
      }),
    catch: (cause) => new Error(String(cause)),
  });

const canConnect = (port: number): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      }),
    catch: (cause) => new Error("nothing is listening on 127.0.0.1:" + port + ": " + String(cause)),
  }).pipe(Effect.timeout("5 seconds"));

const waitForScene = (root: string, projectId: string, scene: string) =>
  call(root, (client) =>
    client.StreamLogs({ projectId, unitName: "scene" }).pipe(
      Stream.filter((line) => line.message === "SCENE " + scene),
      Stream.take(1),
      Stream.runCollect,
    ),
  ).pipe(Effect.timeout("20 seconds"));

describe("connection instances", () => {
  it.live("binds project requirements, routes instances and guards deletion", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-connections-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const obsA = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => startMockObsServer(), catch: (cause) => new Error(String(cause)) }),
        (server) => Effect.promise(() => server.close()),
      );
      const obsB = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => startMockObsServer(), catch: (cause) => new Error(String(cause)) }),
        (server) => Effect.promise(() => server.close()),
      );

      const instances = yield* call(root, (client) =>
        Effect.gen(function* () {
          const a = yield* client.CreateConnection({
            integration: "obs",
            label: "OBS A",
            config: { url: obsA.url },
          });
          const b = yield* client.CreateConnection({
            integration: "obs",
            label: "OBS B",
            config: { url: obsB.url },
          });
          return { a, b };
        }),
      );
      expect(instances.a.boundBy).toEqual([]);
      expect((yield* call(root, (client) => client.ListProjects())).projects).toHaveLength(0);
      const integrations = (yield* call(root, (client) => client.ListIntegrations())).integrations;
      expect(integrations.map((entry) => entry.integration)).toHaveLength(9);
      expect(
        integrations.find((entry) => entry.integration === "obs")?.fields.map((field) => field.key),
      ).toEqual(["url", "password"]);
      const twitch = integrations.find((entry) => entry.integration === "twitch");
      expect(twitch?.modes).toContain("cloud");
      expect(twitch?.redirectUrl).toBe(
        `http://localhost:${DEFAULT_TWITCH_CALLBACK_PORT}/callback`,
      );

      const projectA = yield* makeProject(root, "project-a");
      const addedA = yield* call(root, (client) => client.AddProject({ path: projectA, name: "A" }));
      expect(addedA.requirements[0]?.boundInstanceId).toBeUndefined();
      expect(addedA.requirements[0]?.proposedInstanceId).toBeUndefined();
      const blocked = yield* call(root, (client) => client.StartProject({ projectId: addedA.summary.id }));
      expect(blocked.summary.status).toBe("needs-user");
      expect(blocked.issues.some((issue) => issue.kind === "needs-binding")).toBe(true);
      const blockedDetail = yield* waitForProject(
        root,
        addedA.summary.id,
        (detail) => detail.issues.some((issue) => issue.kind === "needs-binding"),
      );
      expect(blockedDetail.summary.status).toBe("needs-user");
      const checked = yield* call(root, (client) => client.CheckProject({ projectId: addedA.summary.id }));
      expect(checked.missingConnections).toHaveLength(1);
      expect(checked.availableConnections).toHaveLength(2);
      const checkedDetail = yield* waitForProject(
        root,
        addedA.summary.id,
        (detail) => detail.issues.some((issue) => issue.kind === "needs-binding"),
      );
      expect(checkedDetail.summary.status).toBe("needs-user");

      const boundA = yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: addedA.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: instances.a.id,
        }),
      );
      expect(boundA.requirements[0]?.boundInstanceId).toBe(instances.a.id);
      yield* call(root, (client) => client.StartProject({ projectId: addedA.summary.id }));
      yield* call(root, (client) => approve(client, addedA.summary.id));
      const startedA = yield* call(root, (client) => client.StartProject({ projectId: addedA.summary.id }));
      expect(startedA.summary.status).toBe("running");
      expect(startedA.issues).toEqual([]);

      const projectB = yield* makeProject(root, "project-b");
      const addedB = yield* call(root, (client) => client.AddProject({ path: projectB, name: "B" }));
      yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: addedB.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: instances.b.id,
        }),
      );
      yield* call(root, (client) => client.StartProject({ projectId: addedB.summary.id }));
      yield* call(root, (client) => approve(client, addedB.summary.id));
      yield* call(root, (client) => client.StartProject({ projectId: addedB.summary.id }));

      obsA.emit("CurrentProgramSceneChanged", {
        sceneName: "A",
        sceneUuid: "uuid-A",
      });
      obsB.emit("CurrentProgramSceneChanged", {
        sceneName: "B",
        sceneUuid: "uuid-B",
      });
      yield* waitForScene(root, addedA.summary.id, "A");
      yield* waitForScene(root, addedB.summary.id, "B");

      const boundDelete = yield* call(root, (client) => client.DeleteConnection({ id: instances.a.id })).pipe(Effect.exit);
      expect(boundDelete._tag).toBe("Failure");

      const rebound = yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: addedA.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: instances.b.id,
        }),
      );
      expect(rebound.summary.status).toBe("running");
      obsB.emit("CurrentProgramSceneChanged", {
        sceneName: "B-after-rebind",
        sceneUuid: "uuid-B-after-rebind",
      });
      yield* waitForScene(root, addedA.summary.id, "B-after-rebind");
      yield* waitForScene(root, addedB.summary.id, "B-after-rebind");

      yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: addedA.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: null,
        }),
      );
      yield* call(root, (client) => client.DeleteConnection({ id: instances.a.id }));
      const boundB = yield* call(root, (client) => client.DeleteConnection({ id: instances.b.id })).pipe(Effect.exit);
      expect(boundB._tag).toBe("Failure");
      expect((yield* call(root, (client) => client.ListConnections())).connections.map((entry) => entry.id)).not.toContain(instances.a.id);
    }),
    120_000,
  );

  it.live("exposes param descriptions and validates string arrays against bound instances", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-param-strings-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const obs = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => startMockObsServer(), catch: (cause) => new Error(String(cause)) }),
        (server) => Effect.promise(() => server.close()),
      );
      const instance = yield* call(root, (client) =>
        client.CreateConnection({ integration: "obs", label: "OBS", config: { url: obs.url } }),
      );
      const project = yield* makeProject(root, "params", paramsSource);
      const added = yield* call(root, (client) => client.AddProject({ path: project, name: "Params" }));
      yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: added.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: instance.id,
        }),
      );

      const detail = yield* call(root, (client) => client.GetProject({ projectId: added.summary.id }));
      const scenes = detail.manifest.params.find((param) => param.key === "scenes");
      expect(scenes?.type).toBe("strings");
      expect(scenes?.description).toBe("Pick one or more OBS scenes");
      expect(scenes?.options).toEqual(["Scene 1", "Scene 2"]);
      const greeting = detail.manifest.params.find((param) => param.key === "greeting");
      expect(greeting?.description).toBe("What to say on air");

      // These kinds always have a runtime value. The view must agree with it
      // instead of demanding a setting the runtime never needs.
      const labels = detail.manifest.params.find((param) => param.key === "labels");
      expect(labels?.default).toEqual([]);
      expect(labels?.value).toEqual([]);
      expect(labels?.required).toBe(false);
      expect(labels?.error).toBeUndefined();
      const enabled = detail.manifest.params.find((param) => param.key === "enabled");
      expect(enabled?.default).toBe(false);
      expect(enabled?.required).toBe(false);
      const mode = detail.manifest.params.find((param) => param.key === "mode");
      expect(mode?.default).toBe("a");
      expect(mode?.required).toBe(false);

      const rejected = yield* call(root, (client) =>
        client.SetProjectParam({
          projectId: added.summary.id,
          key: "scenes",
          value: ["Scene 1", "Missing scene"],
        }),
      ).pipe(Effect.exit);
      expect(rejected._tag).toBe("Failure");

      const updated = yield* call(root, (client) =>
        client.SetProjectParam({
          projectId: added.summary.id,
          key: "scenes",
          value: ["Scene 2"],
        }),
      );
      expect(updated.manifest.params.find((param) => param.key === "scenes")?.value).toEqual(["Scene 2"]);
    }),
    120_000,
  );

  it.live("proposes and confirms the only matching instance at start", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-proposed-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const obs = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => startMockObsServer(), catch: (cause) => new Error(String(cause)) }),
        (server) => Effect.promise(() => server.close()),
      );
      const instance = yield* call(root, (client) =>
        client.CreateConnection({ integration: "obs", label: "Only OBS", config: { url: obs.url } }),
      );
      const project = yield* makeProject(root, "project");
      const added = yield* call(root, (client) => client.AddProject({ path: project, name: "Proposed" }));
      expect(added.requirements[0]?.boundInstanceId).toBeUndefined();
      expect(added.requirements[0]?.proposedInstanceId).toBe(instance.id);
      yield* call(root, (client) => client.StartProject({ projectId: added.summary.id }));
      const afterStart = yield* call(root, (client) => client.GetProject({ projectId: added.summary.id }));
      expect(afterStart.pendingConsent?.bindings).toEqual([
        { integration: "obs", slot: "main", instanceId: instance.id },
      ]);
      yield* call(root, (client) => approve(client, added.summary.id));
      yield* call(root, (client) => client.StartProject({ projectId: added.summary.id }));
      const running = yield* call(root, (client) => client.GetProject({ projectId: added.summary.id }));
      expect(running.requirements[0]?.boundInstanceId).toBe(instance.id);
    }),
    120_000,
  );
  it.live("reports an unreachable OBS as disconnected and recovers", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-obs-down-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const obs = yield* Effect.promise(() => startMockObsServer());
      const port = obs.port;

      const instance = yield* call(root, (client) =>
        client.CreateConnection({
          integration: "obs",
          label: "Down OBS",
          config: { url: "ws://127.0.0.1:" + String(port) },
        }),
      );
      const project = yield* makeProject(root, "obs-down");
      const added = yield* call(root, (client) =>
        client.AddProject({ path: project, name: "OBS Down" }),
      );
      yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: added.summary.id,
          integration: "obs",
          slot: "main",
          instanceId: instance.id,
        }),
      );
      yield* call(root, (client) => client.StartProject({ projectId: added.summary.id }));
      yield* call(root, (client) => approve(client, added.summary.id));
      const running = yield* call(root, (client) =>
        client.GetProject({ projectId: added.summary.id }),
      );
      expect(running.summary.status).toBe("running");

      yield* Effect.promise(() => obs.close());

      const waitForStatus = (status: string): Effect.Effect<ConnectionSummary, unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 150; attempt += 1) {
            const listed = yield* call(root, (client) => client.ListConnections());
            const connection = listed.connections.find((entry) => entry.id === instance.id);
            if (connection?.status === status) return connection;
            yield* Effect.sleep("100 millis");
          }
          return yield* Effect.fail(new Error("connection never became " + status));
        });

      const down = yield* waitForStatus("disconnected");
      expect(down.lastError).toContain("OBS not reachable");
      expect(typeof down.nextRetryAt).toBe("number");

      // Do not flip back to connecting on each backoff attempt.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        yield* Effect.sleep("200 millis");
        const listed = yield* call(root, (client) => client.ListConnections());
        const connection = listed.connections.find((entry) => entry.id === instance.id);
        expect(connection?.status).toBe("disconnected");
      }

      const restarted = yield* Effect.promise(() => startMockObsServer({ port }));
      yield* Effect.addFinalizer(() => Effect.promise(() => restarted.close()));

      const up = yield* waitForStatus("connected");
      expect(up.lastError).toBeUndefined();
      expect(up.nextRetryAt).toBeUndefined();
    }),
    120_000,
  );

  it.live("listens on each slot's declared port and reconnects unless disconnected", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-ws-server-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const ports = yield* freePorts(3);
      const pixelPort = ports[0];
      const deckPort = ports[1];
      const unusedPort = ports[2];
      if (pixelPort === undefined || deckPort === undefined || unusedPort === undefined) {
        return yield* Effect.fail(new Error("could not reserve ports"));
      }
      const content = [
        'import * as Websocket from "@ballast/module-websocket";',
        'import { Effect } from "effect";',
        "",
        "export default Effect.gen(function* () {",
        `  const pixels = yield* Websocket.Server("pixels", { port: ${pixelPort} });`,
        `  const deck = yield* Websocket.Server("streamdeck", { port: ${deckPort} });`,
        '  yield* Websocket.ClientConnected.subscribe("pixel-connected", pixels, () => Effect.void);',
        '  yield* Websocket.ServerMessage.subscribe("streamdeck-keys", deck, () => Effect.void);',
        "});",
        "",
      ].join("\n");

      const project = yield* makeProject(root, "ws-project", content);
      const added = yield* call(root, (client) =>
        client.AddProject({ path: project, name: "WebSocket project" }),
      );
      const instance = yield* call(root, (client) =>
        client.CreateConnection({
          integration: "websocket-server",
          label: "Shared server",
          // The connection port must not override the ports the script declares.
          config: { port: String(unusedPort) },
        }),
      );
      for (const slot of ["pixels", "streamdeck"]) {
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId: added.summary.id,
            integration: "websocket-server",
            slot,
            instanceId: instance.id,
          }),
        );
      }
      yield* call(root, (client) => client.StartProject({ projectId: added.summary.id }));
      yield* call(root, (client) => approve(client, added.summary.id));
      const started = yield* call(root, (client) =>
        client.StartProject({ projectId: added.summary.id }),
      );
      expect(started.summary.status).toBe("running");

      const status = () =>
        call(root, (client) => client.ListConnections()).pipe(
          Effect.map((listed) => listed.connections.find((entry) => entry.id === instance.id)),
        );
      const waitForStatus = (wanted: ConnectionSummary["status"]) =>
        waitFor("connection " + wanted, () =>
          status().pipe(Effect.map((value) => (value?.status === wanted ? value : undefined))),
        );

      const connected = yield* waitForStatus("connected");
      expect(connected.detail).toContain(":" + String(pixelPort));
      expect(connected.detail).toContain(":" + String(deckPort));
      yield* canConnect(pixelPort);
      yield* canConnect(deckPort);
      // The unused connection setting is not opened.
      yield* canConnect(unusedPort).pipe(Effect.exit, Effect.map((exit) => expect(exit._tag).toBe("Failure")));

      const disconnected = yield* call(root, (client) =>
        client.DisconnectConnection({ connectionId: instance.id }),
      );
      expect(disconnected.status).toBe("disconnected");
      for (let attempt = 0; attempt < 6; attempt += 1) {
        yield* Effect.sleep("500 millis");
        const current = yield* status();
        expect(current?.status).toBe("disconnected");
      }

      const reconnected = yield* call(root, (client) =>
        client.ConnectConnection({ connectionId: instance.id }),
      );
      expect(reconnected.status).toBe("connected");
      yield* canConnect(pixelPort);
      yield* canConnect(deckPort);
    }),
    120_000,
  );

  it.live("retries a listener whose port is taken until it can bind", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-ws-retry-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const ports = yield* freePorts(1);
      const port = ports[0];
      if (port === undefined) return yield* Effect.fail(new Error("could not reserve a port"));
      const blocker = yield* Effect.acquireRelease(holdPort(port), (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );

      const content = [
        'import * as Websocket from "@ballast/module-websocket";',
        'import { Effect } from "effect";',
        "",
        "export default Effect.gen(function* () {",
        '  const pixels = yield* Websocket.Server("pixels");',
        '  yield* Websocket.ClientConnected.subscribe("pixel-connected", pixels, () => Effect.void);',
        "});",
        "",
      ].join("\n");
      const project = yield* makeProject(root, "ws-retry-project", content);
      const added = yield* call(root, (client) =>
        client.AddProject({ path: project, name: "WebSocket retry" }),
      );
      const instance = yield* call(root, (client) =>
        client.CreateConnection({
          integration: "websocket-server",
          label: "Retrying server",
          config: { port: String(port) },
        }),
      );
      yield* call(root, (client) =>
        client.SetProjectBinding({
          projectId: added.summary.id,
          integration: "websocket-server",
          slot: "pixels",
          instanceId: instance.id,
        }),
      );
      yield* call(root, (client) => client.StartProject({ projectId: added.summary.id }));
      yield* call(root, (client) => approve(client, added.summary.id));
      const started = yield* call(root, (client) =>
        client.StartProject({ projectId: added.summary.id }),
      );
      expect(started.summary.status).toBe("running");

      const status = () =>
        call(root, (client) => client.ListConnections()).pipe(
          Effect.map((listed) => listed.connections.find((entry) => entry.id === instance.id)),
        );
      yield* waitFor("connection error", () =>
        status().pipe(Effect.map((value) => (value?.status === "error" ? value : undefined))),
      );

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            blocker.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      );

      const connected = yield* waitFor("connection connected", () =>
        status().pipe(Effect.map((value) => (value?.status === "connected" ? value : undefined))),
        30_000,
      );
      expect(connected.lastError).toBeUndefined();
      yield* canConnect(port);
    }),
    120_000,
  );
});
