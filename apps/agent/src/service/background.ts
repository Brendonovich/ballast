import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { withAgentClient } from "./client.ts";
import {
  processAlive,
  readEnvironment,
  readServiceRegistration,
  resolveDataDir,
  resolveStateDir,
} from "./config.ts";
import type { Environment, ServiceRegistration } from "./config.ts";
import { ensureDir } from "./fs.ts";

/**
 * The CLI side of the background service (decision 0003 §2): no launchd or
 * Task Scheduler. A client adopts the service named by service.json when it
 * answers /health, spawns `ballast serve` as a detached process otherwise, and
 * restarts it by stopping it and spawning a new one.
 */

const START_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(7);
const KILL_TIMEOUT = Duration.seconds(3);
const POLL = Schedule.spaced(Duration.millis(150));

const environmentKeys = [
  "BALLAST_STATE_DIR",
  "BALLAST_DATA_DIR",
  "BALLAST_LOG_DIR",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "HOME",
] as const;

export class BackgroundServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundServiceError";
  }
}

const probeHealth = (registration: ServiceRegistration): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const response = await fetch(`${registration.url.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) return false;
      const pid = "pid" in body ? body.pid : undefined;
      return "apiVersion" in body && body.apiVersion === 1 && (pid === undefined || pid === registration.pid);
    } catch {
      return false;
    }
  });

/** The registered service, if it answers /health as the pid service.json names. */
export const findRunningService = (
  env?: Environment,
): Effect.Effect<ServiceRegistration | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const values = env ?? (yield* readEnvironment(environmentKeys));
    for (const stateDir of [resolveStateDir(path, values), resolveDataDir(path, values)]) {
      const registration = yield* readServiceRegistration(stateDir);
      if (registration !== undefined && (yield* probeHealth(registration))) return registration;
    }
    return undefined;
  });

const waitFor = <A>(
  label: string,
  timeout: Duration.Duration,
  check: Effect.Effect<A | undefined, never, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, BackgroundServiceError, FileSystem.FileSystem | Path.Path> =>
  check.pipe(
    Effect.flatMap((value) =>
      value === undefined ? Effect.fail(new BackgroundServiceError(label)) : Effect.succeed(value),
    ),
    Effect.retry(POLL),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new BackgroundServiceError(label)),
    }),
  );

const waitForExit = (pid: number, timeout: Duration.Duration): Effect.Effect<boolean> =>
  Effect.suspend(() => (processAlive(pid) ? Effect.fail("alive" as const) : Effect.succeed(true))).pipe(
    Effect.retry(POLL),
    Effect.catch(() => Effect.succeed(false)),
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) }),
  );

const signal = (pid: number, name: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // already gone
    }
  });

/**
 * Spawn `ballast serve` with this CLI's own runtime and entry, detached from
 * the terminal (own session, no stdin) and logging to the log dir.
 */
const spawnService = (
  values: Environment,
): Effect.Effect<number | undefined, BackgroundServiceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const entry = process.argv[1];
    if (entry === undefined) return yield* Effect.fail(new BackgroundServiceError("Cannot find the ballast entry point"));
    const logDir = values["BALLAST_LOG_DIR"] ?? path.join(resolveStateDir(path, values), "logs");
    yield* ensureDir(logDir, 0o700).pipe(
      Effect.mapError((cause) => new BackgroundServiceError("Cannot create " + logDir + ": " + String(cause))),
    );
    return yield* Effect.try({
      try: () => {
        const stdout = openSync(path.join(logDir, "service.log"), "a", 0o600);
        const stderr = openSync(path.join(logDir, "service.err.log"), "a", 0o600);
        try {
          const child = spawn(process.execPath, [...process.execArgv, entry, "serve"], {
            env: { ...process.env, BALLAST_LOG_DIR: logDir },
            detached: true,
            stdio: ["ignore", stdout, stderr],
            windowsHide: true,
          });
          child.unref();
          return child.pid;
        } finally {
          closeSync(stdout);
          closeSync(stderr);
        }
      },
      catch: (cause) => new BackgroundServiceError("Could not start the service: " + String(cause)),
    });
  });

/** Adopt the running service or start one in the background. */
export const ensureService = (): Effect.Effect<
  { readonly registration: ServiceRegistration; readonly started: boolean },
  BackgroundServiceError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const values = yield* readEnvironment(environmentKeys);
    const running = yield* findRunningService(values);
    if (running !== undefined) return { registration: running, started: false };
    const pid = yield* spawnService(values);
    const registration = yield* waitFor(
      "The Ballast service did not start within 30s (see service.err.log in the log dir)",
      START_TIMEOUT,
      findRunningService(values),
    ).pipe(
      Effect.tapError(() => (pid === undefined ? Effect.void : signal(pid, "SIGKILL"))),
    );
    return { registration, started: true };
  });

/** Stop the running service: ShutdownService, then SIGTERM, then SIGKILL. */
export const stopService = (): Effect.Effect<
  ServiceRegistration | undefined,
  BackgroundServiceError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const registration = yield* findRunningService();
    if (registration === undefined) return undefined;
    const pid = registration.pid;
    const asked = yield* withAgentClient((client) => client.ShutdownService({ force: false })).pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (asked && (yield* waitForExit(pid, STOP_TIMEOUT))) return registration;
    yield* signal(pid, "SIGTERM");
    if (yield* waitForExit(pid, STOP_TIMEOUT)) return registration;
    yield* signal(pid, "SIGKILL");
    if (yield* waitForExit(pid, KILL_TIMEOUT)) return registration;
    return yield* Effect.fail(new BackgroundServiceError(`Service process ${pid} did not exit`));
  });
