import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stdio from "effect/Stdio";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  NodeCrypto,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
  NodeStdio,
  NodeTerminal,
} from "@effect/platform-node";
import { AgentRpcs } from "@ballast/agent-protocol";
import {
  AGENT_NAME,
  AGENT_VERSION,
  acquireLock,
  clearServiceFiles,
  makeServiceToken,
  resolveServiceVersion,
  writeServiceRegistration,
} from "./config.ts";
import type { ServeOptions, ServiceRegistration } from "./config.ts";
import { ArtifactGatewayLive } from "./artifact-gateway.ts";
import { ProjectStoresLive } from "./artifact-stores.ts";
import { ArtifactTokensLive } from "./artifact-tokens.ts";
import { CloudLink, CloudLinkLive } from "./cloud-link.ts";
import { EventHistoryLive } from "./event-history.ts";
import { ConnectionManager, ConnectionManagerLive } from "./connections.ts";
import { devKeyboardLayer, devMidiLayer } from "./dev-input.ts";
import { registerHttpRoutes } from "./http.ts";
import { Lifecycle, LifecycleLive } from "./lifecycle.ts";
import { ProjectManager, ProjectManagerLive } from "./projects.ts";
import { ProjectRuntime, ProjectRuntimeLive } from "./project-runtime.ts";
import { ProjectSharesLive } from "./shares.ts";
import { AgentRpcsLive } from "./rpc.ts";
import { ensureProjectTypes } from "./scaffold.ts";
import {
  EventLog,
  EventLogLive,
  Logs,
  LogsLive,
  ServiceHubLive,
  EventRouter,
  EventRouterLive,
} from "./telemetry.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const installLogDir = (
  logDir: string | undefined,
  stdoutIsTerminal: boolean,
): Effect.Effect<Effect.Effect<void>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (logDir === undefined) return Effect.void;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(logDir, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    const logFile = path.join(logDir, "service.log");
    const stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    // A background service spawned by the desktop app or CLI already has
    // stdout/stderr pointing at the log files. Only mirror when running
    // interactively to avoid duplicate lines.
    if (!stdoutIsTerminal) {
      stream.end();
      return Effect.void;
    }
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...args: ReadonlyArray<unknown>) => {
      stream.write(chunk);
      return stdoutWrite(chunk as never, ...(args as never[]));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...args: ReadonlyArray<unknown>) => {
      stream.write(chunk);
      return stderrWrite(chunk as never, ...(args as never[]));
    }) as typeof process.stderr.write;
    return Effect.sync(() => {
      process.stdout.write = stdoutWrite as typeof process.stdout.write;
      process.stderr.write = stderrWrite as typeof process.stderr.write;
      stream.end();
    });
  });

const installProcessHandlers = (
  lifecycle: Lifecycle["Service"],
  supervised: boolean,
): Effect.Effect<ReadonlyArray<() => void>> =>
  Effect.sync(() => {
    const cleanups: Array<() => void> = [];
    const stop = () => {
      Effect.runFork(lifecycle.stop(0));
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, stop);
      cleanups.push(() => process.off(signal, stop));
    }
    if (supervised) {
      const onEnd = () => {
        Effect.runFork(lifecycle.stop(0));
      };
      process.stdin.on("end", onEnd);
      process.stdin.on("close", onEnd);
      process.stdin.resume();
      cleanups.push(() => {
        process.stdin.off("end", onEnd);
        process.stdin.off("close", onEnd);
        process.stdin.pause();
      });
    }
    const onDisconnect = () => {
      Effect.runFork(lifecycle.stop(0));
    };
    process.on("disconnect", onDisconnect);
    cleanups.push(() => process.off("disconnect", onDisconnect));
    return cleanups;
  });

const makeLayers = (
  options: ServeOptions,
  startedAt: number,
  version: string,
  devFakeInput: boolean,
) => {
  const base = Layer.mergeAll(
    LogsLive,
    EventLogLive,
    EventHistoryLive,
    ServiceHubLive,
    LifecycleLive,
    ProjectManagerLive(options.dataDir),
    HttpRouter.layer,
    RpcSerialization.layerJson,
  );
  const events = EventRouterLive.pipe(Layer.provideMerge(base));
  const cloud = CloudLinkLive({
    dataDir: options.dataDir,
    cloudUrl: options.cloudUrl,
  }).pipe(Layer.provideMerge(events), Layer.provideMerge(base));
  const connections = ConnectionManagerLive({
    dataDir: options.dataDir,
    ...(options.dev && devFakeInput
      ? { keyboardLayer: devKeyboardLayer, midiLayer: devMidiLayer }
      : {}),
  }).pipe(Layer.provideMerge(events), Layer.provideMerge(cloud));
  const stores = ProjectStoresLive;
  const projects = ProjectRuntimeLive({
    dataDir: options.dataDir,
    version,
  }).pipe(
    Layer.provideMerge(connections),
    Layer.provideMerge(stores),
    Layer.provideMerge(events),
  );
  const tokens = ArtifactTokensLive.pipe(Layer.provideMerge(projects));
  const gateway = ArtifactGatewayLive.pipe(
    Layer.provideMerge(tokens),
    Layer.provideMerge(projects),
  );
  const shares = ProjectSharesLive({ dataDir: options.dataDir }).pipe(
    Layer.provideMerge(projects),
  );
  const handlers = AgentRpcsLive({
    stateDir: options.stateDir,
    dataDir: options.dataDir,
    startedAt,
    version,
    cloudUrl: options.cloudUrl,
  }).pipe(
    Layer.provideMerge(gateway),
    Layer.provideMerge(shares),
    Layer.provideMerge(projects),
  );
  const server = NodeHttpServer.layer(() => createServer(), {
    host: "127.0.0.1",
    port: options.port,
  });
  return handlers.pipe(Layer.provideMerge(server));
};

/**
 * Run the long-lived service until a shutdown request or signal; resolves with
 * the exit code. Nothing supervises it: the desktop app or CLI spawns it as a
 * detached process and restarts it by stopping it and spawning a new one.
 */
/*
 * Effect v4's NodeHttpServer.layer exposes NodeServices as a union whose
 * members do not unify with the individual service keys the handlers require.
 * Every Node service is provided by the layers below at runtime; the assertion
 * keeps this platform entry's requirements at `never`.
 */
export const runServe = (options: ServeOptions): Effect.Effect<number, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
    yield* acquireLock(options.stateDir).pipe(
      Effect.mapError((cause) => new Error(cause.message)),
    );

    const startedAt = Date.now();
    const stdio = yield* Stdio.Stdio;
    const stdoutIsTerminal = yield* stdio.stdoutIsTerminal;
    const token = yield* makeServiceToken();
    const portRef = yield* Ref.make(options.port);
    const version = yield* resolveServiceVersion().pipe(
      Effect.catch(() => Effect.succeed(AGENT_VERSION)),
    );
    const devFakeInput = yield* Config.String("BALLAST_DEV_FAKE_INPUT").pipe(
      Config.option,
      Effect.map((value) => Option.contains(value, "1")),
      Effect.catch(() => Effect.succeed(false)),
    );
    const stopLogging = yield* installLogDir(options.logDir, stdoutIsTerminal);
    yield* Effect.addFinalizer(() => stopLogging);
    const layer = makeLayers(options, startedAt, version, devFakeInput);

    const program = Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (!("port" in address)) {
        return yield* Effect.fail(new Error("The HTTP server did not bind a TCP port"));
      }
      const port = address.port;
      yield* Ref.set(portRef, port);
      const url = `http://127.0.0.1:${port}`;

      const projects = yield* ProjectManager;
      const runtime = yield* ProjectRuntime;
      const connections = yield* ConnectionManager;
      const cloud = yield* CloudLink;
      const logs = yield* Logs;
      const eventLog = yield* EventLog;
      const lifecycle = yield* Lifecycle;
      const router = yield* HttpRouter.HttpRouter;
      const eventRouter = yield* EventRouter;

      // Create/repoint <dataDir>/types/current before any project is planned,
      // including projects that outlived an app update.
      yield* ensureProjectTypes({ dataDir: options.dataDir, version }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not prepare project types: " + error.message),
        ),
        Effect.ignore,
      );
      yield* runtime.syncAll;
      yield* runtime.hydrateEvents;
      yield* runtime.resumeEnabled();
      yield* eventRouter.finishWarmup;

      const devToken = options.dev
        ? yield* Config.String("BALLAST_DEV_TOKEN").pipe(
            Config.option,
            Effect.map(Option.getOrUndefined),
            Effect.catch(() => Effect.succeed(undefined)),
          )
        : undefined;
      const health = (): Effect.Effect<Record<string, unknown>> =>
        Effect.gen(function* () {
          const projectCounts = yield* runtime.counts;
          const connectionList = yield* connections.summaries();
          const cloudStatus = yield* cloud.status;
          const shellPermissions = yield* connections.permissions();
          return {
            projects: projectCounts,
            connections: {
              total: connectionList.length,
              connected: connectionList.filter(
                (connection) => connection.status === "connected",
              ).length,
              error: connectionList.filter(
                (connection) => connection.status === "error",
              ).length,
            },
            cloud: cloudStatus.state,
            permissions: shellPermissions,
            lastLogSeq: yield* logs.lastSeq,
            lastEventSeq: yield* eventLog.lastSeq,
          };
        });
      yield* registerHttpRoutes(router, {
        token,
        dev: options.dev,
        devToken: devToken === undefined || devToken === "" ? undefined : devToken,
        port: portRef,
        webDir: options.webDir,
        startedAt,
        version,
        pid: process.pid,
        health,
      }, lifecycle);

      const protocol = yield* RpcServer.makeProtocolWebsocket({ path: "/rpc" });
      yield* RpcServer.make(AgentRpcs).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );

      yield* Effect.gen(function* () {
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("1 second");
            yield* runtime.syncAll.pipe(Effect.catchCause(() => Effect.void));
          }),
        );
      }).pipe(Effect.forkScoped);

      const cleanups = yield* installProcessHandlers(lifecycle, options.supervised);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const cleanup of cleanups) cleanup();
        }),
      );

      const projectList = yield* projects.projects;
      const registration: ServiceRegistration = {
        schemaVersion: 1,
        apiVersion: 1,
        name: AGENT_NAME,
        version,
        url,
        token,
        pid: process.pid,
        ...(projectList[0] === undefined ? {} : { defaultProjectId: projectList[0].id }),
        startedAt,
        dataDir: options.dataDir,
        stateDir: options.stateDir,
      };
      yield* writeServiceRegistration(options.stateDir, registration);

      yield* HttpServer.serveEffect()(router.asHttpEffect());
      yield* Effect.log(`Ballast service listening on ${url}`);

      const code = yield* lifecycle.wait;
      // Never let a wedged finalizer or a stray timer hold the process open:
      // the desktop replaces services with SIGTERM and waits only seconds.
      const watchdog = setTimeout(() => {
        console.error("Ballast service forced exit after shutdown timeout");
        process.exit(code);
      }, 2_000);
      watchdog.unref();
      yield* Effect.log(`Ballast service stopping (exit ${code})`);
      const bounded = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
        effect.pipe(Effect.timeoutOption("1 second"), Effect.ignore);
      yield* bounded(runtime.closeAll());
      yield* bounded(connections.close());
      yield* bounded(cloud.close());
      return code;
    });

    return yield* Effect.scoped(program.pipe(Effect.provide(layer))).pipe(
      Effect.mapError((cause) => new Error(errorMessage(cause))),
      Effect.ensuring(clearServiceFiles(options.stateDir)),
    );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        NodeFileSystem.layer,
        NodePath.layer,
        NodeStdio.layer,
        NodeTerminal.layer,
      ),
    ),
  ) as Effect.Effect<number, Error>;
