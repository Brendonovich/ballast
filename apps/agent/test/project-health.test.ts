import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import type { ProjectDetail } from "@ballast/agent-protocol";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";
import { startMockObsServer } from "./mock-obs-server.ts";
import { startMockCloudServer } from "./support/mock-cloud.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

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
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodePath.layer),
    Effect.provide(NodeCrypto.layer),
    Effect.mapError(asError),
  );

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
          BALLAST_ARTIFACT_PORT: "0",
          BALLAST_PROJECTS_DIR: join(root, "projects"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    yield* waitFor("service", () =>
      Effect.promise(async () => {
        const registration = await Effect.runPromise(
          readServiceRegistration(join(root, "state")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
        );
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

const makeProject = (
  root: string,
  name: string,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const project = join(root, name);
    yield* Effect.promise(async () => {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "ballast.ts"), source, "utf8");
    });
    return project;
  });

const getDetail = (root: string, projectId: string) =>
  call(root, (client) => client.GetProject({ projectId }));

const waitForProject = (
  root: string,
  projectId: string,
  predicate: (detail: ProjectDetail) => boolean,
  timeoutMs = 30_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let latest: ProjectDetail | undefined;
    while (Date.now() < deadline) {
      latest = yield* getDetail(root, projectId);
      if (predicate(latest)) return latest;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(
      new Error(
        "Timed out waiting for project state; last=" +
          JSON.stringify(latest ?? null),
      ),
    );
  });

const obsSource = [
  'import * as OBS from "@ballast/module-obs";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const obs = yield* OBS.Connection("main");',
  '  yield* OBS.CurrentProgramSceneChanged.subscribe("scene", obs, (event) =>',
  "    obs.SetCurrentProgramScene({ sceneName: event.sceneName }),",
  "  );",
  "});",
  "",
].join("\n");

const runSource = (name: string, body: string): string =>
  [
    'import * as Ballast from "@ballast/core";',
    'import { Effect } from "effect";',
    "",
    "export default Effect.gen(function* () {",
    "  yield* Ballast.run(" + JSON.stringify(name) + ", " + body + ");",
    "});",
    "",
  ].join("\n");

describe("project health", () => {
  it.live(
    "starts with an offline OBS connection and delivers after it connects",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-offline-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());
        const server = yield* Effect.tryPromise({
          try: () => startMockObsServer(),
          catch: (cause) => new Error(String(cause)),
        });
        const url = server.url;
        yield* Effect.promise(() => server.close());

        const connection = yield* call(root, (client) =>
          client.CreateConnection({
            integration: "obs",
            label: "Offline OBS",
            config: { url },
          }),
        );
        const project = yield* makeProject(root, "offline", obsSource);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Offline" }),
        );
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId: added.summary.id,
            integration: "obs",
            slot: "main",
            instanceId: connection.id,
          }),
        );

        let started = yield* call(root, (client) =>
          client.StartProject({ projectId: added.summary.id }),
        );
        if (started.issues.some((issue) => issue.kind === "needs-consent")) {
          const consents = yield* call(root, (client) =>
            client.ListProjectConsents({ projectId: added.summary.id }),
          );
          for (const consent of consents.consents) {
            yield* call(root, (client) =>
              client.ApproveProjectConsent({ consentId: consent.id }),
            );
          }
          started = yield* call(root, (client) =>
            client.StartProject({ projectId: added.summary.id }),
          );
        }
        expect(started.summary.status, JSON.stringify(started.issues)).toBe("running");

        const offline = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.some((issue) => issue.kind === "connection-offline"),
        );
        expect(offline.summary.status).toBe("running");
        const scene = offline.units.find((unit) => unit.kind === "topic" && unit.name === "scene");
        expect(scene?.status).toBe("waiting");

        const online = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startMockObsServer({ port: server.port, scenes: ["Scene 1", "Scene 2"] }),
            catch: (cause) => new Error(String(cause)),
          }),
          (value) => Effect.promise(() => value.close()),
        );
        yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.every((issue) => issue.kind !== "connection-offline"),
        );
        const connected = yield* waitForProject(root, added.summary.id, (detail) => {
          const unit = detail.units.find(
            (candidate) => candidate.kind === "topic" && candidate.name === "scene",
          );
          return unit?.status === "active";
        });
        expect(connected.issues).toEqual([]);

        online.emit("CurrentProgramSceneChanged", {
          sceneName: "Scene 2",
          sceneUuid: "uuid-Scene-2",
        });
        yield* waitFor(
          "OBS scene change after reconnect",
          () =>
            Effect.sync(() =>
              online.currentScene() === "Scene 2" ? online.currentScene() : undefined,
            ),
        );
      }),
    120_000,
  );

  it.live(
    "contains a failing run and keeps the project running",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-run-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const source = [
          'import * as Ballast from "@ballast/core";',
          'import { Effect } from "effect";',
          "",
          "export default Effect.gen(function* () {",
          '  yield* Ballast.run("boom", Effect.sync(() => {',
          '    throw new Error("run exploded");',
          "  }));",
          '  yield* Ballast.run("alive", Effect.gen(function* () {',
          '    yield* Effect.log("alive");',
          "    yield* Effect.never;",
          "  }));",
          "});",
          "",
        ].join("\n");
        const project = yield* makeProject(root, "failing-run", source);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Failing run" }),
        );
        const started = yield* call(root, (client) =>
          client.StartProject({ projectId: added.summary.id }),
        );
        expect(started.summary.status).toBe("running");

        const failed = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.some((issue) => issue.kind === "unit-failed"),
        );
        expect(failed.summary.status).toBe("running");
        const issue = failed.issues.find(
          (candidate) => candidate.kind === "unit-failed",
        );
        expect(issue?.unit).toBe("boom");
        expect(issue?.detail).toContain("run exploded");
        expect(
          failed.units.find((unit) => unit.name === "boom")?.status,
        ).toBe("failed");
        expect(
          failed.units.find((unit) => unit.name === "alive")?.status,
        ).toBe("active");
      }),
    120_000,
  );


  it.live(
    "contains a failing event handler on its unit",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-handler-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const connection = yield* call(root, (client) =>
          client.CreateConnection({ integration: "fake", label: "Fake", config: {} }),
        );
        const source = [
          'import * as Ballast from "@ballast/core";',
          'import * as Fake from "@ballast/fake";',
          'import { Effect } from "effect";',
          "",
          "export default Effect.gen(function* () {",
          '  const fake = yield* Fake.Connection("main");',
          '  yield* Fake.Tick.subscribe("tick", fake, () =>',
          '    Effect.fail(new Error("handler exploded")),',
          "  );",
          '  yield* Ballast.run("alive", Effect.gen(function* () {',
          '    yield* Effect.log("alive");',
          "    yield* Effect.never;",
          "  }));",
          "});",
          "",
        ].join("\n");
        const project = yield* makeProject(root, "failing-handler", source);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Failing handler" }),
        );
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId: added.summary.id,
            integration: "fake",
            slot: "main",
            instanceId: connection.id,
          }),
        );

        let started = yield* call(root, (client) =>
          client.StartProject({ projectId: added.summary.id }),
        );
        if (started.issues.some((issue) => issue.kind === "needs-consent")) {
          const consents = yield* call(root, (client) =>
            client.ListProjectConsents({ projectId: added.summary.id }),
          );
          for (const consent of consents.consents) {
            yield* call(root, (client) =>
              client.ApproveProjectConsent({ consentId: consent.id }),
            );
          }
          started = yield* call(root, (client) =>
            client.StartProject({ projectId: added.summary.id }),
          );
        }
        expect(started.summary.status).toBe("running");

        const failed = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.some(
            (issue) => issue.kind === "unit-failed" && issue.unit === "tick",
          ),
        );
        expect(failed.summary.status).toBe("running");
        const issue = failed.issues.find(
          (candidate) => candidate.kind === "unit-failed" && candidate.unit === "tick",
        );
        expect(issue?.detail).toContain("handler exploded");
        expect(failed.units.find((unit) => unit.name === "tick")?.status).toBe("failed");
        expect(failed.units.find((unit) => unit.name === "alive")?.status).toBe("active");
      }),
    120_000,
  );

  it.live(
    "approving consent on a stopped project enables and starts it",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-approve-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const connection = yield* call(root, (client) =>
          client.CreateConnection({ integration: "fake", label: "Fake", config: {} }),
        );
        const source = [
          'import * as Fake from "@ballast/fake";',
          'import { Effect } from "effect";',
          "",
          "export default Effect.gen(function* () {",
          '  const fake = yield* Fake.Connection("main");',
          '  yield* Fake.Tick.subscribe("tick", fake, () => Effect.void);',
          "});",
          "",
        ].join("\n");
        const project = yield* makeProject(root, "approve-consent", source);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Approve consent" }),
        );
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId: added.summary.id,
            integration: "fake",
            slot: "main",
            instanceId: connection.id,
          }),
        );

        let consents = yield* call(root, (client) =>
          client.ListProjectConsents({ projectId: added.summary.id }),
        );
        if (consents.consents.length === 0) {
          yield* call(root, (client) =>
            client.PlanProject({ projectId: added.summary.id }),
          );
          consents = yield* call(root, (client) =>
            client.ListProjectConsents({ projectId: added.summary.id }),
          );
        }
        const consent = consents.consents[0];
        expect(consent).toBeDefined();
        if (consent === undefined) return;

        const before = yield* getDetail(root, added.summary.id);
        expect(before.summary.status).toBe("needs-user");
        expect(before.summary.enabled).toBe(false);

        const approved = yield* call(root, (client) =>
          client.ApproveProjectConsent({ consentId: consent.id }),
        );
        expect(approved.summary.enabled).toBe(true);
        expect(approved.summary.status).toBe("running");
        expect(approved.pendingConsent).toBeUndefined();

        const after = yield* getDetail(root, added.summary.id);
        expect(after.summary.status).toBe("running");
        expect(after.units.some((unit) => unit.status === "active")).toBe(true);
      }),
    120_000,
  );
  it.live(
    "marks the project failed when the worker exits, without restarting",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-exit-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const source = runSource("crash", "Effect.sync(() => process.exit(3))");
        const project = yield* makeProject(root, "worker-exit", source);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Worker exit" }),
        );
        const started = yield* call(root, (client) =>
          client.StartProject({ projectId: added.summary.id }),
        );
        expect(started.summary.status).toBe("running");

        const exited = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.some((issue) => issue.kind === "worker-exited"),
        );
        expect(exited.summary.status).toBe("failed");
        expect(exited.summary.enabled).toBe(true);
        const issue = exited.issues.find(
          (candidate) => candidate.kind === "worker-exited",
        );
        expect(issue?.detail).toContain("exit code 3");

        yield* Effect.sleep("2 seconds");
        const after = yield* getDetail(root, added.summary.id);
        expect(after.summary.status).toBe("failed");
        expect(after.issues.filter((issue) => issue.kind === "worker-exited")).toHaveLength(1);
      }),
    120_000,
  );

  it.live(
    "keeps the worker running on a broken edit and clears the issue",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-edit-")),
        );
        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const source = runSource(
          "forever",
          'Effect.gen(function* () { yield* Effect.log("tick"); yield* Effect.never; })',
        );
        const project = yield* makeProject(root, "bad-edit", source);
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Bad edit" }),
        );
        const started = yield* call(root, (client) =>
          client.StartProject({ projectId: added.summary.id }),
        );
        expect(started.summary.status).toBe("running");

        yield* Effect.promise(() =>
          writeFile(join(project, "ballast.ts"), 'const broken: number = "nope";\n', "utf8"),
        );
        const failed = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.some((issue) => issue.kind === "change-not-applied"),
        );
        expect(failed.summary.status).toBe("running");
        const issue = failed.issues.find(
          (candidate) => candidate.kind === "change-not-applied",
        );
        expect(issue?.detail).toContain("TS2322");
        expect(issue?.source?.file.endsWith("ballast.ts")).toBe(true);

        yield* Effect.promise(() =>
          writeFile(join(project, "ballast.ts"), source, "utf8"),
        );
        const recovered = yield* waitForProject(root, added.summary.id, (detail) =>
          detail.issues.every((issue) => issue.kind !== "change-not-applied"),
        );
        expect(recovered.summary.status).toBe("running");
      }),
    120_000,
  );

  it.live(
    "clears a Twitch lastError after the cloud recovers",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "ballast-health-twitch-")),
        );
        const cloud = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startMockCloudServer(),
            catch: (cause) => new Error(String(cause)),
          }),
          (value) => Effect.promise(() => value.close()),
        );
        const paired = yield* runCliToExit(
          ["pair", "ABC123", "--cloud", cloud.url],
          { BALLAST_DATA_DIR: join(root, "data") },
        );
        expect(paired.code).toBe(0);

        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const connection = yield* call(root, (client) =>
          client.CreateConnection({
            integration: "twitch",
            label: "Twitch",
            mode: "cloud",
            config: { connection: cloud.connectionId },
          }),
        );

        // Re-authorizing a cloud connection opens the cloud's OAuth flow with
        // the scopes the connection needs, not a dead-end message.
        const auth = yield* call(root, (client) =>
          client.StartConnectionAuth({ connectionId: connection.id }),
        );
        expect(auth._tag).toBe("browser");
        if (auth._tag === "browser") {
          expect(auth.url.startsWith(cloud.url + "/oauth/twitch/start?scopes=")).toBe(
            true,
          );
          expect(decodeURIComponent(auth.url.split("scopes=")[1] ?? "")).toContain(
            "user:read:email",
          );
          expect(auth.expiresAt).toBeGreaterThan(Date.now());
        }

        cloud.setFailConnections(true);
        yield* call(root, (client) =>
          client.ConnectConnection({ connectionId: connection.id }),
        );
        const broken = yield* waitFor("Twitch error", () =>
          Effect.gen(function* () {
            const connections = yield* call(root, (client) => client.ListConnections());
            const current = connections.connections.find(
              (candidate) => candidate.id === connection.id,
            );
            return current?.status === "error" ? current : undefined;
          }),
        );
        expect(broken.lastError).toBeDefined();

        cloud.setFailConnections(false);
        yield* call(root, (client) =>
          client.ConnectConnection({ connectionId: connection.id }),
        );
        const recovered = yield* waitFor("Twitch reconnect", () =>
          Effect.gen(function* () {
            const connections = yield* call(root, (client) => client.ListConnections());
            const current = connections.connections.find(
              (candidate) => candidate.id === connection.id,
            );
            return current?.status === "connected" ? current : undefined;
          }),
        );
        expect(recovered.lastError).toBeUndefined();
      }),
    120_000,
  );
});

const runCliToExit = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<{ readonly output: string; readonly code: number }, Error> =>
  Effect.gen(function* () {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, CI: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const result = yield* Effect.callback<{ output: string; code: number }>((resume) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("exit", (code) => {
        resume(Effect.succeed({ output, code: code ?? -1 }));
      });
      return Effect.sync(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      });
    });
    return { ...result, output: result.output };
  });
