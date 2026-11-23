import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { DEFAULT_TWITCH_CALLBACK_PORT, type ProjectDetail } from "@ballast/agent-protocol";
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
  '  yield* OBS.CurrentProgramSceneChanged.subscribe("scene", obs, () =>',
  '    Effect.gen(function* () {',
  '      yield* Effect.log("SCENES " + (yield* scenes).join(",") + " " + (yield* greeting));',
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
      expect(integrations.map((entry) => entry.integration)).toHaveLength(8);
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
      const blocked = yield* call(root, (client) => client.StartProject({ projectId: addedA.summary.id })).pipe(Effect.exit);
      expect(blocked._tag).toBe("Failure");
      const blockedDetail = yield* waitForProject(
        root,
        addedA.summary.id,
        (detail) => detail.summary.lastError?.includes("unbound connections") === true,
      );
      expect(blockedDetail.summary.lastError).toContain("unbound connections");
      const checked = yield* call(root, (client) => client.CheckProject({ projectId: addedA.summary.id }));
      expect(checked.missingConnections).toHaveLength(1);
      expect(checked.availableConnections).toHaveLength(2);
      const checkedDetail = yield* waitForProject(
        root,
        addedA.summary.id,
        (detail) => detail.summary.lastError?.includes("unbound connections") === true,
      );
      expect(checkedDetail.summary.lastError).toContain("unbound connections");

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
      expect(startedA.summary.lastError).toBeUndefined();

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

      obsA.emit("CurrentProgramSceneChanged", { sceneName: "A" });
      obsB.emit("CurrentProgramSceneChanged", { sceneName: "B" });
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
      obsB.emit("CurrentProgramSceneChanged", { sceneName: "B-after-rebind" });
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
});
