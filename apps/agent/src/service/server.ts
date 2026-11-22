import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { NodeHttpServer } from "@effect/platform-node";
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
import { CloudLink, CloudLinkLive } from "./cloud-link.ts";
import { ConnectionManager, ConnectionManagerLive } from "./connections.ts";
import { devKeyboardLayer, devMidiLayer } from "./dev-input.ts";
import { registerHttpRoutes } from "./http.ts";
import { Lifecycle, LifecycleLive } from "./lifecycle.ts";
import { ProjectManager, ProjectManagerLive } from "./projects.ts";
import { AgentRpcsLive } from "./rpc.ts";
import { ScriptManager, ScriptManagerLive } from "./scripts.ts";
import {
  EventLog,
  EventLogLive,
  Logs,
  LogsLive,
  ServiceHubLive,
  EventRouterLive,
} from "./telemetry.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const installLogDir = (logDir: string | undefined): Effect.Effect<Effect.Effect<void>> =>
  Effect.sync(() => {
    if (logDir === undefined) return Effect.void;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = join(logDir, "service.log");
    const stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    // Under the installed supervisor stdout/stderr already point at the log
    // files. Only mirror when running interactively to avoid duplicate lines.
    if (process.stdout.isTTY !== true) {
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

const makeLayers = (options: ServeOptions, startedAt: number, version: string) => {
  const base = Layer.mergeAll(
    LogsLive,
    EventLogLive,
    ServiceHubLive,
    LifecycleLive,
    ProjectManagerLive(options.dataDir),
    HttpRouter.layer,
    RpcSerialization.layerJson,
  );
  const cloud = CloudLinkLive({
    dataDir: options.dataDir,
    cloudUrl: options.cloudUrl,
  }).pipe(Layer.provideMerge(base));
  const events = EventRouterLive.pipe(Layer.provideMerge(cloud));
  const connections = ConnectionManagerLive({
    dataDir: options.dataDir,
    ...(options.dev && process.env["BALLAST_DEV_FAKE_INPUT"] === "1"
      ? { keyboardLayer: devKeyboardLayer, midiLayer: devMidiLayer }
      : {}),
  }).pipe(Layer.provideMerge(events));
  const scripts = ScriptManagerLive.pipe(Layer.provideMerge(connections));
  const handlers = AgentRpcsLive({
    stateDir: options.stateDir,
    dataDir: options.dataDir,
    startedAt,
    version,
    cloudUrl: options.cloudUrl,
  }).pipe(Layer.provideMerge(scripts));
  const server = NodeHttpServer.layer(() => createServer(), {
    host: "127.0.0.1",
    port: options.port,
  });
  return handlers.pipe(Layer.provideMerge(server));
};

/**
 * Run the long-lived service. Resolves with the exit code: 0 for a normal
 * ShutdownService, 75 for RestartService so the OS supervisor respawns it.
 */
export const runServe = (options: ServeOptions): Effect.Effect<number, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => acquireLock(options.stateDir),
      catch: (cause) => new Error(errorMessage(cause)),
    });

    const startedAt = Date.now();
    const token = makeServiceToken();
    const portRef = yield* Ref.make(options.port);
    const version = yield* Effect.tryPromise({
      try: () => resolveServiceVersion(),
      catch: (cause) => new Error(errorMessage(cause)),
    }).pipe(Effect.catch(() => Effect.succeed(AGENT_VERSION)));
    const stopLogging = yield* installLogDir(options.logDir);
    yield* Effect.addFinalizer(() => stopLogging);
    const layer = makeLayers(options, startedAt, version);

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
      const scripts = yield* ScriptManager;
      const connections = yield* ConnectionManager;
      const cloud = yield* CloudLink;
      const logs = yield* Logs;
      const eventLog = yield* EventLog;
      const lifecycle = yield* Lifecycle;
      const router = yield* HttpRouter.HttpRouter;

      yield* scripts.syncAll;
      yield* scripts.resumeEnabled();

      const devToken = options.dev ? process.env["BALLAST_DEV_TOKEN"] : undefined;
      const health = (): Effect.Effect<Record<string, unknown>> =>
        Effect.gen(function* () {
          const counts = yield* scripts.counts;
          const connectionList = yield* connections.summaries();
          const cloudStatus = yield* cloud.status;
          const projectList = yield* projects.projects;
          return {
            projects: { total: projectList.length },
            scripts: counts,
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
            yield* scripts.syncAll.pipe(Effect.catchCause(() => Effect.void));
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
      yield* Effect.tryPromise({
        try: () => writeServiceRegistration(options.stateDir, registration),
        catch: (cause) => new Error(`Could not write service.json: ${errorMessage(cause)}`),
      });

      yield* HttpServer.serveEffect()(router.asHttpEffect());
      yield* Effect.log(`Ballast service listening on ${url}`);

      const code = yield* lifecycle.wait;
      yield* Effect.log(`Ballast service stopping (exit ${code})`);
      yield* scripts.closeAll();
      yield* connections.close();
      yield* cloud.close();
      return code;
    });

    return yield* Effect.scoped(program.pipe(Effect.provide(layer))).pipe(
      Effect.mapError((cause) => new Error(errorMessage(cause))),
      Effect.ensuring(clearServiceFiles(options.stateDir)),
    );
    }),
  );
