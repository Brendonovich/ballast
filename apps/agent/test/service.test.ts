import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";
import { fileExists } from "../src/service/fs.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const tickSource = [
  'import * as Fake from "@ballast/fake";',
  'import { Effect } from "effect";',
  "",
  'export const title = "Tick Echo";',
  "",
  "export default Effect.gen(function* () {",
  '  const fake = yield* Fake.Connection("main");',
  '  yield* Fake.Tick.subscribe("tick", fake, (tick) =>',
  '    Effect.log("tick " + tick.n),',
  "  );",
  "});",
  "",
].join("\n");

interface ServiceProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exit: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

const spawnService = (env: Readonly<Record<string, string>>): Effect.Effect<ServiceProcess> =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<number>();
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "serve", "--port", "0"],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      Deferred.doneUnsafe(exit, Exit.succeed(code ?? -1));
    });
    return {
      child,
      output: () => output,
      exit: Deferred.await(exit),
      kill: Effect.gen(function* () {
        if (child.exitCode !== null) return;
        child.kill("SIGKILL");
        yield* Deferred.await(exit);
      }),
    };
  });

const waitFor = <A>(
  label: string,
  effect: Effect.Effect<A | undefined>,
  output: () => string,
  timeoutMs = 20_000,
): Effect.Effect<A, Error> =>
  Effect.gen(function* () {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = yield* effect;
      if (value !== undefined) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(
      new Error(`Timed out waiting for ${label}\n--- service output ---\n${output()}`),
    );
  });

const makeProject = (
  root: string,
  name: string,
  source: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const project = join(root, name);
    yield* Effect.promise(() => mkdir(project, { recursive: true }));
    yield* Effect.promise(() => writeFile(join(project, "ballast.ts"), source, "utf8"));
    return project;
  });

const startProject = (
  call: <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>) => Effect.Effect<A, E | Error>,
  projectId: string,
) =>
  Effect.gen(function* () {
    for (let round = 0; round < 50; round++) {
      yield* call((client) => client.StartProject({ projectId })).pipe(
        Effect.catch(() => Effect.void),
      );
      const detail = yield* call((client) => client.GetProject({ projectId }));
      if (detail.summary.status === "running") return detail;
      const consents = yield* call((client) => client.ListProjectConsents({ projectId }));
      for (const consent of consents.consents) {
        yield* call((client) => client.ApproveProjectConsent({ consentId: consent.id }));
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Project did not start: " + projectId));
  });

const bindFake = (
  call: <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>) => Effect.Effect<A, E | Error>,
  projectId: string,
) =>
  Effect.gen(function* () {
    const connection = yield* call((client) =>
      client.CreateConnection({ integration: "fake", label: "Fake", config: {} }),
    );
    yield* call((client) =>
      client.SetProjectBinding({
        projectId,
        integration: "fake",
        slot: "main",
        instanceId: connection.id,
      }),
    );
  });

describe("ballast serve", () => {
  it.live(
    "serves project RPCs over WebSocket and resumes both projects after restart",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-service-test-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const projectA = yield* makeProject(root, "project-a", tickSource);
        const projectB = yield* makeProject(root, "project-b", tickSource);
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));

        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };
        const service = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);
        const registration = yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
          service.output,
        );
        expect(registration.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(registration.token.length).toBeGreaterThan(20);

        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>) =>
          withAgentClient(use, { ...env }).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );

        yield* waitFor(
          "health endpoint",
          Effect.promise(async () => ((await fetch(`${registration.url}/health`)).ok ? true : undefined)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          ),
          service.output,
        );

        const info = yield* call((client) => client.GetServiceInfo());
        expect(info.name).toBe("ballast-agent");
        expect(info.apiVersion).toBe(1);
        expect(info.pid).toBe(service.child.pid);

        const emptyHealth = yield* call((client) => client.GetHealth());
        expect(emptyHealth.projects.total).toBe(0);

        const projectADetail = yield* call((client) =>
          client.AddProject({ path: projectA, name: "Project A" }),
        );
        const projectBDetail = yield* call((client) =>
          client.AddProject({ path: projectB, name: "Project B" }),
        );
        expect(projectADetail.units.some((unit) => unit.kind === "topic")).toBe(true);
        expect((yield* call((client) => client.ListProjects())).projects.map((p) => p.name)).toEqual([
          "Project A",
          "Project B",
        ]);

        yield* bindFake(call, projectADetail.summary.id);
        yield* bindFake(call, projectBDetail.summary.id);
        yield* startProject(call, projectADetail.summary.id);
        yield* startProject(call, projectBDetail.summary.id);
        yield* call((client) => client.StopProject({ projectId: projectBDetail.summary.id }));
        yield* call((client) => client.StartProject({ projectId: projectBDetail.summary.id }));

        yield* call((client) =>
          client.StreamLogs({ projectId: projectADetail.summary.id }).pipe(
            Stream.filter((entry) => entry.message.includes("tick ")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const integrations = yield* call((client) => client.ListIntegrations());
        expect(integrations.integrations.length).toBe(8);
        const connection = yield* call((client) => client.ListConnections());
        expect(connection.connections.some((entry) => entry.integration === "fake")).toBe(true);

        const health = yield* call((client) => client.GetHealth());
        expect(health.projects.total).toBe(2);
        expect(health.projects.running).toBe(2);

        yield* call((client) => client.ShutdownService({ force: false }));
        const restartCode = yield* service.exit.pipe(Effect.timeout("20 seconds"));
        expect(restartCode).toBe(0);
        expect(
          yield* fileExists(join(stateDir, "service.json")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
        ).toBe(false);

        const relaunched = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);
        yield* waitFor(
          "relaunched service.json",
          readServiceRegistration(stateDir).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
          relaunched.output,
        );
        yield* waitFor(
          "resumed projects",
          call((client) => client.ListProjects()).pipe(
            Effect.map((result) =>
              result.projects.length === 2 &&
              result.projects.every((project) => project.status === "running")
                ? result
                : undefined,
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
          relaunched.output,
          30_000,
        );

        yield* call((client) => client.RemoveProject({ projectId: projectBDetail.summary.id }));
        expect(
          yield* fileExists(join(projectB, "ballast.ts")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
        ).toBe(true);
        expect((yield* call((client) => client.ListProjects())).projects).toHaveLength(1);

        yield* call((client) => client.ShutdownService({ force: false }));
        const shutdownCode = yield* relaunched.exit.pipe(Effect.timeout("20 seconds"));
        expect(shutdownCode).toBe(0);
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    180_000,
  );

  it.live(
    "matches the desktop launcher contract: version, health, cookie exchange and POST shutdown",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-desktop-test-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const logDir = join(root, "logs");
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));
        const service = yield* Effect.acquireRelease(
          spawnService({
            BALLAST_STATE_DIR: stateDir,
            BALLAST_DATA_DIR: dataDir,
            BALLAST_LOG_DIR: logDir,
            BALLAST_SERVICE_VERSION: "9.9.9-desktop-test",
            BALLAST_WEB_DIR: join(root, "missing-web"),
          }),
          (process) => process.kill,
        );
        const registration = yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
          service.output,
        );
        expect(registration.version).toBe("9.9.9-desktop-test");
        expect(registration.pid).toBe(service.child.pid);
        const health = yield* waitFor(
          "health",
          Effect.promise(async () => {
            const response = await fetch(`${registration.url}/health`);
            if (!response.ok) return undefined;
            return (await response.json()) as Record<string, unknown>;
          }).pipe(Effect.catch(() => Effect.succeed(undefined))),
          service.output,
        );
        expect(health["apiVersion"]).toBe(1);
        expect(health["version"]).toBe("9.9.9-desktop-test");
        expect(health["pid"]).toBe(service.child.pid);

        const exchange = yield* Effect.promise(() =>
          fetch(`${registration.url}/?token=${encodeURIComponent(registration.token)}`, {
            redirect: "manual",
          }),
        );
        expect(exchange.status).toBe(302);
        expect(exchange.headers.get("location")).toBe("/");
        const cookie = exchange.headers.get("set-cookie") ?? "";
        expect(cookie).toContain("ballast_session=" + registration.token);
        expect(cookie.toLowerCase()).toContain("httponly");
        expect(cookie.toLowerCase()).toContain("samesite=strict");
        const page = yield* Effect.promise(() =>
          fetch(`${registration.url}/`, {
            headers: { cookie: "ballast_session=" + registration.token },
          }),
        );
        expect(page.status).toBe(200);
        expect(yield* Effect.promise(() => page.text())).toContain("Ballast");

        const shutdown = yield* Effect.promise(() =>
          fetch(`${registration.url}/shutdown`, {
            method: "POST",
            headers: { authorization: "Bearer " + registration.token },
          }),
        );
        expect(shutdown.status).toBe(202);
        const code = yield* service.exit.pipe(Effect.timeout("20 seconds"));
        expect(code).toBe(0);
        expect(
          yield* fileExists(join(logDir, "service.log")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
        ).toBe(true);
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    60_000,
  );

  it.live(
    "plans and runs a project with no node_modules",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-no-modules-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const project = yield* makeProject(root, "project", tickSource);
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));
        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };
        const service = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);
        yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
          service.output,
        );
        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>) =>
          withAgentClient(use, { ...env }).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );
        const detail = yield* call((client) =>
          client.AddProject({ path: project, name: "No modules" }),
        );
        const projectId = detail.summary.id;
        const planned = yield* call((client) => client.GetProject({ projectId }));
        expect(planned.manifest.topics[0]?.topic).toBe("fake/tick");
        yield* bindFake(call, projectId);
        yield* startProject(call, projectId);
        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("tick 1")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));
        yield* call((client) => client.ShutdownService({ force: false }));
        yield* service.exit.pipe(Effect.timeout("20 seconds"));
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    60_000,
  );
});
