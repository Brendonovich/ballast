import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration, serviceJsonPath } from "../src/service/config.ts";
import { fileExists } from "../src/service/fs.ts";
import { startMockObsServer } from "./mock-obs-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const agentNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const tickScript = `import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const prefix = yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
    const fake = yield* Fake.Connection("main");
    const echo = yield* Fake.Echo(fake);
    yield* Fake.Tick.subscribe("tick", fake, (tick) =>
      Effect.gen(function* () {
        const { text } = yield* echo({ text: \`\${yield* prefix} tick \${tick.n}\` });
        yield* Effect.log(text);
      }),
    );
});
`;

const obsScript = `import * as Ballast from "@ballast/core";
import * as OBS from "@ballast/module-obs";
import { Effect } from "effect";

export default Effect.gen(function* () {
    const scene = yield* Ballast.Param.string("scene", { options: OBS.scenes("main"), default: "Scene 1" });
    const obs = yield* OBS.Connection("main");
    yield* OBS.CurrentProgramSceneChanged.subscribe("scene-changed", obs, (event) =>
      Effect.log(\`scene now \${event.sceneName}\`),
    );
    yield* Ballast.run(
      "obs-loop",
      Effect.gen(function* () {
        const target = yield* scene;
        yield* obs.SetCurrentProgramScene({ sceneName: target });
        yield* Effect.log("obs set done");
        yield* Effect.never;
      }),
    );
});
`;

interface ServiceProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exit: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

const spawnService = (
  env: Readonly<Record<string, string>>,
): Effect.Effect<ServiceProcess> =>
  Effect.sync(() => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        bin,
        "serve",
        "--port",
        "0",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const exit = Deferred.makeUnsafe<number>();
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

const sleep = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`);

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
      yield* sleep(100);
    }
    return yield* Effect.fail(
      new Error(`Timed out waiting for ${label}\n--- service output ---\n${output()}`),
    );
  });

const makeProject = (root: string, scripts: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(join(root, "scripts"), { recursive: true }));
    yield* Effect.promise(() =>
      mkdir(join(root, "node_modules", "@ballast"), { recursive: true }),
    );
    for (const pkg of ["core", "fake", "module-obs"]) {
      yield* Effect.promise(() =>
        symlink(join(agentNodeModules, "@ballast", pkg), join(root, "node_modules", "@ballast", pkg), "dir"),
      );
    }
    yield* Effect.promise(() =>
      symlink(join(agentNodeModules, "effect"), join(root, "node_modules", "effect"), "dir"),
    );
    for (const [name, source] of Object.entries(scripts)) {
      yield* Effect.promise(() => writeFile(join(root, "scripts", name), source, "utf8"));
    }
  });

describe("ballast serve", () => {
  it.live(
    "serves every AgentRpcs member over WebSocket across two projects and restarts",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-service-test-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const projectA = join(root, "project-a");
        const projectB = join(root, "project-b");
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));
        yield* makeProject(projectA, { "tick-echo.ts": tickScript, "obs-touch.ts": obsScript });
        yield* makeProject(projectB, { "tick-echo.ts": tickScript });

        const obs = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startMockObsServer({ scenes: ["Scene 1", "Scene 2"] }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
          (server) => Effect.promise(() => server.close()),
        );

        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };

        const service = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);

        const registration = yield* waitFor(
          "service.json",
          Effect.promise(() => readServiceRegistration(stateDir)),
          service.output,
        );
        expect(registration.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(registration.token.length).toBeGreaterThan(20);

        const call = <A, E>(
          use: (client: LiveAgentClient) => Effect.Effect<A, E>,
        ): Effect.Effect<A, E | Error> =>
          withAgentClient(use, { ...env }).pipe(
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
          Effect.promise(async () => {
            const response = await fetch(`${registration.url}/health`);
            return response.ok ? true : undefined;
          }).pipe(Effect.catch(() => Effect.succeed(undefined))),
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
        expect(projectADetail.scripts.map((script) => script.id)).toEqual([
          "scripts/obs-touch.ts",
          "scripts/tick-echo.ts",
        ]);
        expect(projectADetail.scripts.every((script) => script.status === "stopped")).toBe(
          true,
        );

        const projects = yield* call((client) => client.ListProjects());
        expect(projects.projects.map((project) => project.name)).toEqual([
          "Project A",
          "Project B",
        ]);
        const listedA = yield* call((client) =>
          client.GetProject({ projectId: projectADetail.summary.id }),
        );
        expect(listedA.summary.scriptCount).toBe(2);

        const allScripts = yield* call((client) => client.ListScripts({}));
        expect(allScripts.scripts).toHaveLength(3);
        const detail = yield* call((client) =>
          client.GetScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        );
        expect(detail.manifest.params[0]?.key).toBe("prefix");
        expect(detail.manifest.connections[0]?.integration).toBe("fake");
        const source = yield* call((client) =>
          client.GetScriptSource({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        );
        expect(source.path).toBe("scripts/tick-echo.ts");
        expect(source.content).toContain("Effect.gen");
        expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(source.language).toBe("typescript");
        const planned = yield* call((client) =>
          client.PlanScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        );
        expect(planned.manifest.topics[0]?.topic).toBe("fake/tick");

        const configuredObs = yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "obs/main",
            values: [{ key: "url", value: obs.url }],
          }),
        );
        expect(configuredObs.status).not.toBe("unconfigured");
        const obsDetail = yield* call((client) =>
          client.GetScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/obs-touch.ts",
          }),
        );
        expect(obsDetail.manifest.params[0]?.options).toEqual(["Scene 1", "Scene 2"]);

        const connections = yield* call((client) => client.ListConnections());
        expect(connections.connections.map((connection) => connection.id)).toContain(
          "obs/main",
        );
        const fakeConnection = yield* call((client) =>
          client.GetConnection({ connectionId: "fake/main" }),
        );
        expect(fakeConnection.status).not.toBe("unconfigured");

        const startedTick = yield* call((client) =>
          client.StartScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(startedTick)).toBe(true);
        const tickConsent = (yield* call((client) => client.ListConsents({}))).consents.find(
          (consent) =>
            consent.projectId === projectADetail.summary.id &&
            consent.scriptId === "scripts/tick-echo.ts",
        );
        expect(tickConsent).toBeDefined();
        if (tickConsent === undefined) return;
        const approvedTick = yield* call((client) =>
          client.ApproveConsent({ consentId: tickConsent.id }),
        );
        expect(approvedTick.summary.status).toBe("running");
        expect(approvedTick.summary.enabled).toBe(true);
        const runningFake = yield* call((client) =>
          client.GetConnection({ connectionId: "fake/main" }),
        );
        expect(runningFake.status).toBe("connected");
        expect(runningFake.label).toBe("Fake");

        const firstTick = yield* call((client) =>
          client.StreamLogs({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }).pipe(
            Stream.filter((entry) => /^> tick \d+$/.test(entry.message)),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("15 seconds"));
        expect(firstTick[0]?.message).toMatch(/^> tick \d+$/);

        const startedObs = yield* call((client) =>
          client.StartScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/obs-touch.ts",
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(startedObs)).toBe(true);
        const obsConsent = (yield* call((client) => client.ListConsents({}))).consents.find(
          (consent) => consent.scriptId === "scripts/obs-touch.ts",
        );
        expect(obsConsent).toBeDefined();
        if (obsConsent === undefined) return;
        const approvedObs = yield* call((client) =>
          client.ApproveConsent({ consentId: obsConsent.id }),
        );
        expect(approvedObs.summary.status).toBe("running");

        yield* call((client) =>
          client.StartScript({
            projectId: projectBDetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        ).pipe(Effect.exit);
        const bConsent = (yield* call((client) => client.ListConsents({}))).consents.find(
          (consent) => consent.projectId === projectBDetail.summary.id,
        );
        expect(bConsent).toBeDefined();
        if (bConsent !== undefined) {
          const rejected = yield* call((client) =>
            client.RejectConsent({ consentId: bConsent.id }),
          );
          expect(rejected.summary.status).toBe("stopped");
          expect(rejected.summary.enabled).toBe(false);
          yield* call((client) =>
            client.StartScript({
              projectId: projectBDetail.summary.id,
              scriptId: "scripts/tick-echo.ts",
            }),
          ).pipe(Effect.exit);
          const retried = (yield* call((client) => client.ListConsents({}))).consents.find(
            (consent) => consent.projectId === projectBDetail.summary.id,
          );
          expect(retried).toBeDefined();
          if (retried !== undefined) {
            yield* call((client) => client.ApproveConsent({ consentId: retried.id }));
          }
        }

        const changed = yield* call((client) =>
          client.SetScriptParam({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
            key: "prefix",
            value: "hi",
          }),
        );
        expect(changed.manifest.params[0]?.value).toBe("hi");
        expect(changed.summary.generation).toBeGreaterThan(1);

        yield* call((client) =>
          client.StreamLogs({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }).pipe(
            Stream.filter((entry) => entry.message.includes("hi tick")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        yield* call((client) =>
          client.StreamEvents({
            projectId: projectADetail.summary.id,
          }).pipe(
            Stream.filter((event) => event.direction === "outbound"),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const sourceEvent = yield* Effect.forkChild(
          call((client) =>
            client.WatchService({}).pipe(
              Stream.filter(
                (event) =>
                  event._tag === "script-source-changed" &&
                  event.projectId === projectADetail.summary.id &&
                  event.scriptId === "scripts/tick-echo.ts",
              ),
              Stream.take(1),
              Stream.runCollect,
            ),
          ),
        );
        yield* Effect.sleep("300 millis");
        yield* Effect.promise(() =>
          writeFile(
            join(projectA, "scripts", "tick-echo.ts"),
            tickScript + "\n// e2e source change\n",
            "utf8",
          ),
        );
        const changedSource = yield* Fiber.join(sourceEvent).pipe(
          Effect.timeout("15 seconds"),
        );
        expect(changedSource[0]?._tag).toBe("script-source-changed");

        const watchChunk = yield* call((client) =>
          client.WatchService({}).pipe(Stream.take(1), Stream.runCollect),
        );
        const snapshot = watchChunk[0];
        expect(snapshot).toBeDefined();
        if (snapshot === undefined) return;
        expect(snapshot._tag).toBe("snapshot");
        if (snapshot._tag === "snapshot") {
          expect(snapshot.snapshot.projects).toHaveLength(2);
          expect(snapshot.snapshot.scripts).toHaveLength(3);
          expect(
            snapshot.snapshot.connections.some((connection) => connection.id === "obs/main"),
          ).toBe(true);
        }

        yield* Effect.sleep("500 millis");
        obs.emit("CurrentProgramSceneChanged", { sceneName: "Scene 2" });
        yield* call((client) =>
          client.StreamLogs({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/obs-touch.ts",
          }).pipe(
            Stream.filter((entry) => entry.message.includes("scene now Scene 2")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const stopped = yield* call((client) =>
          client.StopScript({
            projectId: projectBDetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        );
        expect(stopped.summary.status).toBe("stopped");
        expect(stopped.summary.enabled).toBe(false);
        const disabled = yield* call((client) =>
          client.SetScriptEnabled({
            projectId: projectBDetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
            enabled: true,
          }),
        );
        expect(disabled.summary.status).toBe("running");
        const restarted = yield* call((client) =>
          client.RestartScript({
            projectId: projectADetail.summary.id,
            scriptId: "scripts/tick-echo.ts",
          }),
        );
        expect(restarted.summary.status).toBe("running");

        const secondary = yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "obs/secondary",
            values: [{ key: "url", value: obs.url }],
          }),
        );
        expect(secondary.status).not.toBe("unconfigured");
        const connectedSecondary = yield* call((client) =>
          client.ConnectConnection({ connectionId: "obs/secondary" }),
        );
        expect(connectedSecondary.status).toBe("connected");
        const disconnectedSecondary = yield* call((client) =>
          client.DisconnectConnection({ connectionId: "obs/secondary" }),
        );
        expect(disconnectedSecondary.status).toBe("disconnected");

        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "twitch/broadcaster",
            values: [
              { key: "clientId", value: "test-client-id" },
              { key: "clientSecret", value: "test-client-secret" },
            ],
            mode: "local-app",
          }),
        );
        const auth = yield* call((client) =>
          client.StartConnectionAuth({ connectionId: "twitch/broadcaster" }),
        );
        expect(auth._tag).toBe("browser");
        if (auth._tag === "browser") expect(auth.url).toContain("oauth");

        const cloudStatus = yield* call((client) => client.GetCloudStatus());
        expect(cloudStatus.state).toBe("unlinked");
        const begin = yield* call((client) =>
          client.BeginCloudPairing({ machineName: "Test machine" }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(begin)).toBe(true);
        const pair = yield* call((client) =>
          client.PairCloud({ code: "NOPE", machineName: "Test machine" }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(pair)).toBe(true);
        const unpaired = yield* call((client) => client.UnpairCloud());
        expect(unpaired.state).toBe("unlinked");

        const health = yield* call((client) => client.GetHealth());
        expect(health.projects.total).toBe(2);
        expect(health.scripts.total).toBe(3);
        expect(health.scripts.running).toBe(3);

        yield* call((client) => client.RestartService({ reason: "contract test" }));
        const restartCode = yield* service.exit.pipe(Effect.timeout("20 seconds"));
        expect(restartCode).toBe(75);
        expect(yield* Effect.promise(() => fileExists(serviceJsonPath(stateDir)))).toBe(false);

        const relaunched = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);
        yield* waitFor(
          "relaunched service.json",
          Effect.promise(() => readServiceRegistration(stateDir)),
          relaunched.output,
        );
        const resumed = yield* waitFor(
          "resumed scripts",
          call((client) => client.ListScripts({})).pipe(
            Effect.map((result) =>
              result.scripts.length === 3 &&
              result.scripts.filter((script) => script.status === "running").length === 3
                ? result
                : undefined,
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
          relaunched.output,
        );
        expect(resumed.scripts.every((script) => script.enabled)).toBe(true);

        yield* call((client) =>
          client.RemoveProject({ projectId: projectBDetail.summary.id }),
        );
        expect(yield* Effect.promise(() => fileExists(join(projectB, "scripts", "tick-echo.ts")))).toBe(
          true,
        );
        const afterRemoval = yield* call((client) => client.ListProjects());
        expect(afterRemoval.projects).toHaveLength(1);

        yield* call((client) => client.ShutdownService({ force: false }));
        const shutdownCode = yield* relaunched.exit.pipe(Effect.timeout("20 seconds"));
        expect(shutdownCode).toBe(0);
        expect(yield* Effect.promise(() => fileExists(serviceJsonPath(stateDir)))).toBe(false);

        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    180_000,
  );

  it.live(
    "matches the desktop launcher contract: version, health, cookie exchange and POST restart",
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
          Effect.promise(() => readServiceRegistration(stateDir)),
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

        const restart = yield* Effect.promise(() =>
          fetch(`${registration.url}/restart`, {
            method: "POST",
            headers: { authorization: "Bearer " + registration.token },
          }),
        );
        expect(restart.status).toBe(202);
        const code = yield* service.exit.pipe(Effect.timeout("20 seconds"));
        expect(code).toBe(75);
        expect(
          yield* Effect.promise(() => fileExists(join(logDir, "service.log"))),
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
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(join(stateDir), { recursive: true }));
        yield* Effect.promise(() => mkdir(join(dataDir), { recursive: true }));
        yield* Effect.promise(() => mkdir(join(project, "scripts"), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            join(project, "scripts", "tick-echo.ts"),
            `${tickScript}
export const title = "No Modules Tick";
`,
            "utf8",
          ),
        );
        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };
        const service = yield* Effect.acquireRelease(spawnService(env), (process) => process.kill);
        yield* waitFor(
          "service.json",
          Effect.promise(() => readServiceRegistration(stateDir)),
          service.output,
        );
        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
          withAgentClient(use, { ...env }).pipe(
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );
        const detail = yield* call((client) => client.AddProject({ path: project, name: "No modules" }));
        const projectId = detail.summary.id;
        const planned = yield* call((client) =>
          client.GetScript({ projectId, scriptId: "scripts/tick-echo.ts" }),
        );
        expect(planned.manifest.topics[0]?.topic).toBe("fake/tick");
        expect(planned.summary.name).toBe("No Modules Tick");
        yield* call((client) => client.StartScript({ projectId, scriptId: "scripts/tick-echo.ts" })).pipe(
          Effect.exit,
        );
        const consents = yield* call((client) => client.ListConsents({ projectId }));
        for (const consent of consents.consents) {
          yield* call((client) => client.ApproveConsent({ consentId: consent.id }));
        }
        yield* call((client) =>
          client.StreamLogs({ projectId, scriptId: "scripts/tick-echo.ts" }).pipe(
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
