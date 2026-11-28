import { hostname } from "node:os";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Base64Url from "effect/encoding/Base64Url";
import {
  ensureDir,
  fileExists,
  readJson,
  removeFile,
  writeJsonAtomic,
} from "./fs.ts";

export const AGENT_NAME = "ballast-agent" as const;
export const AGENT_VERSION = "0.1.0-dev.20261123" as const;
export const SERVICE_SCHEMA_VERSION = 1 as const;

export type Environment = Readonly<Record<string, string | undefined>>;

/** Read a fixed set of environment variables through Effect's Config service. */
export const readEnvironment = (
  keys: ReadonlyArray<string>,
): Effect.Effect<Environment> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, string | undefined]> = [];
    for (const key of keys) {
      const value = yield* Config.String(key).pipe(Config.option, Effect.orDie);
      entries.push([key, Option.getOrUndefined(value)] as const);
    }
    return Object.fromEntries(entries);
  });

export interface ServeOptions {
  readonly port: number;
  readonly dev: boolean;
  readonly supervised: boolean;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly webDir: string | undefined;
  readonly logDir: string | undefined;
  readonly cloudUrl: string | undefined;
  /** Built-in default share server (decision 0014); falls back to the cloud URL. */
  readonly shareServer: string | undefined;
}

export class ServeConfigError extends Data.TaggedError("ServeConfigError")<{
  readonly message: string;
}> {}

const parsePort = (raw: string): number => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServeConfigError({ message: `Invalid port "${raw}"` });
  }
  return port;
};

/** Absolute on any platform, so a path written on another OS is still recognized. */
export const isAbsolutePath = (path: string): boolean =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

const envValue = (env: Environment, key: string): string | undefined => {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
};

export const resolveStateDir = (
  path: Path.Path,
  env: Environment,
): string => {
  const stateDir = envValue(env, "BALLAST_STATE_DIR");
  if (stateDir !== undefined) {
    return path.resolve(stateDir);
  }
  const xdgState = envValue(env, "XDG_STATE_HOME");
  if (xdgState !== undefined) {
    return path.join(xdgState, "ballast");
  }
  if (process.platform === "win32" && env["LOCALAPPDATA"] !== undefined) {
    return path.join(env["LOCALAPPDATA"], "Ballast", "state");
  }
  return path.join(env["HOME"] ?? "", ".local", "state", "ballast");
};

export const resolveDataDir = (
  path: Path.Path,
  env: Environment,
): string => {
  const dataDir = envValue(env, "BALLAST_DATA_DIR");
  if (dataDir !== undefined) {
    return path.resolve(dataDir);
  }
  const xdgData = envValue(env, "XDG_DATA_HOME");
  if (xdgData !== undefined) {
    return path.join(xdgData, "ballast");
  }
  if (process.platform === "win32" && env["LOCALAPPDATA"] !== undefined) {
    return path.join(env["LOCALAPPDATA"], "Ballast");
  }
  return path.join(env["HOME"] ?? "", ".local", "share", "ballast");
};

/**
 * Directories where a service registration may live. An explicit
 * BALLAST_STATE_DIR is authoritative: never fall back to the default data
 * directory, or a command aimed at a probe service could act on the user's
 * real service instead. The data directory remains a legacy fallback only
 * when no state directory was chosen explicitly.
 */
export const resolveServiceDirectories = (
  path: Path.Path,
  env: Environment,
): ReadonlyArray<string> => {
  const stateDir = resolveStateDir(path, env);
  if (envValue(env, "BALLAST_STATE_DIR") !== undefined) return [stateDir];
  const dataDir = resolveDataDir(path, env);
  return dataDir === stateDir ? [stateDir] : [stateDir, dataDir];
};

const defaultWebDirs = (
  path: Path.Path,
  cwd: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const moduleDir = yield* path.fromFileUrl(new URL(".", import.meta.url)).pipe(Effect.orDie);
    return [
      path.resolve(moduleDir, "../../../web/dist"),
      path.join(moduleDir, "web"),
      path.join(cwd, "web"),
    ];
  });

export const resolveWebDir = (
  explicit: string | undefined,
  env: Environment,
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configured = explicit ?? envValue(env, "BALLAST_WEB_DIR");
    if (configured !== undefined) return path.resolve(configured);
    const candidates = yield* defaultWebDirs(path, cwd);
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate).pipe(Effect.orDie)) return candidate;
    }
    return candidates[0];
  });

export const parseServeOptions = (
  args: ReadonlyArray<string>,
): Effect.Effect<
  ServeOptions,
  ServeConfigError,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.realPath(".").pipe(Effect.orDie);
    const env = yield* readEnvironment([
      "BALLAST_STATE_DIR",
      "BALLAST_DATA_DIR",
      "BALLAST_WEB_DIR",
      "BALLAST_LOG_DIR",
      "BALLAST_CLOUD_URL",
      "BALLAST_SHARE_SERVER",
      "BALLAST_SERVICE_PORT",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "LOCALAPPDATA",
      "HOME",
    ]);

    let port = env["BALLAST_SERVICE_PORT"] === undefined
      ? 0
      : parsePort(env["BALLAST_SERVICE_PORT"]);
    let dev = false;
    let supervised = false;
    let stateDir: string | undefined;
    let dataDir: string | undefined;
    let webDir: string | undefined;
    let logDir = env["BALLAST_LOG_DIR"];
    let cloudUrl = env["BALLAST_CLOUD_URL"];
    let shareServer = env["BALLAST_SHARE_SERVER"];

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const value = (name: string): string => {
        const next = args[index + 1];
        if (next === undefined) {
          throw new ServeConfigError({ message: `${name} requires a value` });
        }
        index++;
        return next;
      };
      if (arg === "--port") {
        port = parsePort(value("--port"));
        continue;
      }
      if (arg !== undefined && arg.startsWith("--port=")) {
        port = parsePort(arg.slice("--port=".length));
        continue;
      }
      if (arg === "--dev") {
        dev = true;
        continue;
      }
      if (arg === "--supervised") {
        supervised = true;
        continue;
      }
      if (arg === "--state-dir") {
        stateDir = path.resolve(value("--state-dir"));
        continue;
      }
      if (arg !== undefined && arg.startsWith("--state-dir=")) {
        stateDir = path.resolve(arg.slice("--state-dir=".length));
        continue;
      }
      if (arg === "--data-dir") {
        dataDir = path.resolve(value("--data-dir"));
        continue;
      }
      if (arg !== undefined && arg.startsWith("--data-dir=")) {
        dataDir = path.resolve(arg.slice("--data-dir=".length));
        continue;
      }
      if (arg === "--web-dir") {
        webDir = path.resolve(value("--web-dir"));
        continue;
      }
      if (arg !== undefined && arg.startsWith("--web-dir=")) {
        webDir = path.resolve(arg.slice("--web-dir=".length));
        continue;
      }
      if (arg === "--log-dir") {
        logDir = path.resolve(value("--log-dir"));
        continue;
      }
      if (arg !== undefined && arg.startsWith("--log-dir=")) {
        logDir = path.resolve(arg.slice("--log-dir=".length));
        continue;
      }
      if (arg === "--share-server") {
        shareServer = value("--share-server");
        continue;
      }
      if (arg !== undefined && arg.startsWith("--share-server=")) {
        shareServer = arg.slice("--share-server=".length);
        continue;
      }
      if (arg === "--cloud") {
        cloudUrl = value("--cloud");
        continue;
      }
      if (arg !== undefined && arg.startsWith("--cloud=")) {
        cloudUrl = arg.slice("--cloud=".length);
        continue;
      }
      if (arg !== undefined && arg.startsWith("--")) {
        throw new ServeConfigError({ message: `Unknown serve option "${arg}"` });
      }
      if (arg !== undefined) {
        throw new ServeConfigError({ message: `Unexpected argument "${arg}"` });
      }
    }

    return {
      port,
      dev,
      supervised,
      stateDir: stateDir ?? resolveStateDir(path, env),
      dataDir: dataDir ?? resolveDataDir(path, env),
      webDir: yield* resolveWebDir(webDir, env, cwd),
      logDir: logDir === undefined || logDir === "" ? undefined : path.resolve(logDir),
      cloudUrl: cloudUrl === undefined || cloudUrl === "" ? undefined : cloudUrl,
      shareServer: shareServer === undefined || shareServer === "" ? undefined : shareServer,
    };
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof ServeConfigError
          ? error
          : new ServeConfigError({
              message: error instanceof Error ? error.message : String(error),
            }),
      );
    }),
  );

export interface ServiceRegistration {
  readonly schemaVersion: number;
  readonly apiVersion: 1;
  readonly name: "ballast-agent";
  readonly version: string;
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly defaultProjectId?: string;
  readonly startedAt: number;
  readonly dataDir: string;
  readonly stateDir: string;
}

export interface ServiceLock {
  readonly pid: number;
  readonly startedAt: number;
}

export const serviceJsonPath = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "service.json");
export const serviceLockPath = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "service.lock");

export const makeServiceToken = (): Effect.Effect<string, never, SecureRandom.SecureRandom> =>
  Effect.gen(function* () {
    const crypto = yield* SecureRandom.SecureRandom;
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    return Base64Url.encode(bytes);
  });

export const readServiceRegistration = (
  stateDir: string,
): Effect.Effect<
  ServiceRegistration | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const value = yield* readJson(serviceJsonPath(path, stateDir)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record["url"] !== "string" ||
      typeof record["token"] !== "string" ||
      typeof record["pid"] !== "number" ||
      record["apiVersion"] !== 1 ||
      record["name"] !== "ballast-agent"
    ) {
      return undefined;
    }
    return value as ServiceRegistration;
  });

export const writeServiceRegistration = (
  stateDir: string,
  registration: ServiceRegistration,
): Effect.Effect<
  void,
  never,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* ensureDir(stateDir, 0o700);
    yield* writeJsonAtomic(serviceJsonPath(path, stateDir), registration, 0o600);
  }).pipe(Effect.orDie);

export const readServiceLock = (
  stateDir: string,
): Effect.Effect<ServiceLock | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const value = yield* readJson(serviceLockPath(path, stateDir)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return typeof record["pid"] === "number"
      ? {
          pid: record["pid"],
          startedAt:
            typeof record["startedAt"] === "number" ? record["startedAt"] : 0,
        }
      : undefined;
  });

/** Remove service.json and service.lock, but only while they still name this process. */
export const clearServiceFiles = (
  stateDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const registration = yield* readServiceRegistration(stateDir);
    if (registration?.pid === process.pid) yield* removeFile(serviceJsonPath(path, stateDir));
    const lock = yield* readServiceLock(stateDir);
    if (lock?.pid === process.pid) yield* removeFile(serviceLockPath(path, stateDir));
  }).pipe(Effect.ignore);

export const processAlive = (pid: number): boolean => {
  if (pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
};

export const probeHealth = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "apiVersion" in body &&
      body.apiVersion === 1
    );
  } catch {
    return false;
  }
};

/** How long a live lock holder may go without registering before its pid is presumed reused. */
const LOCK_STARTUP_GRACE_MS = 5 * 60_000;

/**
 * Acquire the single-service lock with an exclusive create. A lock whose pid
 * is alive belongs to a running or still-starting service (service.json is
 * written only after warm-up), so it is never taken over; only a dead pid, or
 * a live one that never registered within the grace period (pid reuse), is
 * treated as stale.
 */
export const acquireLock = (
  stateDir: string,
): Effect.Effect<
  void,
  ServeConfigError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* ensureDir(stateDir, 0o700).pipe(Effect.orDie);
    const lockPath = serviceLockPath(path, stateDir);
    const create = fs
      .writeFileString(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n", {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );

    for (let attempt = 0; attempt < 2; attempt++) {
      if (yield* create) return;
      const existing = yield* readServiceLock(stateDir);
      if (existing !== undefined && existing.pid !== process.pid && processAlive(existing.pid)) {
        const registration = yield* readServiceRegistration(stateDir);
        const registered = registration !== undefined && registration.pid === existing.pid;
        const healthy = registered && (yield* Effect.promise(() => probeHealth(registration.url)));
        const starting = !registered && Date.now() - existing.startedAt < LOCK_STARTUP_GRACE_MS;
        if (healthy || starting) {
          return yield* Effect.fail(
            new ServeConfigError({
              message: `A Ballast service is already ${healthy ? "running" : "starting"} (pid ${existing.pid}).`,
            }),
          );
        }
      }
      yield* removeFile(lockPath).pipe(Effect.ignore);
    }
    return yield* Effect.fail(
      new ServeConfigError({ message: "Could not acquire the service lock at " + lockPath }),
    );
  });

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
};

export const tokenEquals = constantTimeEqual;

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

/**
 * In dev the UI is served by a Vite server on whatever loopback port was free,
 * so any loopback port is accepted.
 */
const loopbackAnyPort = (host: string): boolean => {
  const separator = host.lastIndexOf(":");
  if (separator === -1) return false;
  const port = host.slice(separator + 1);
  return loopbackHosts.includes(host.slice(0, separator)) && /^\d{1,5}$/.test(port);
};

export const hostAllowed = (host: string | undefined, port: number, dev: boolean): boolean => {
  if (host === undefined || host === "") return false;
  if (dev && loopbackAnyPort(host)) return true;
  return loopbackHosts.map((name) => `${name}:${port}`).includes(host);
};

export const originAllowed = (
  origin: string | undefined,
  port: number,
  dev: boolean,
): boolean => {
  if (origin === undefined || origin === "") return true;
  // The desktop shell serves the UI from its own scheme (apps/desktop/src/main/app-protocol.ts).
  if (origin === "ballast://app") return true;
  if (!origin.startsWith("http://")) return false;
  const host = origin.slice("http://".length);
  if (dev && loopbackAnyPort(host)) return true;
  return loopbackHosts.map((name) => `${name}:${port}`).includes(host);
};

export const resolveServiceVersion = (): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* readEnvironment(["BALLAST_SERVICE_VERSION"]);
    const configured = envValue(env, "BALLAST_SERVICE_VERSION");
    if (configured !== undefined) return configured;
    const moduleDir = yield* path.fromFileUrl(new URL(".", import.meta.url)).pipe(Effect.orDie);
    const candidates = [
      path.join(moduleDir, "version.json"),
      path.join(moduleDir, "..", "version.json"),
    ];
    for (const candidate of candidates) {
      const value = yield* readJson(candidate).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (typeof value === "object" && value !== null) {
        const version = (value as { version?: unknown }).version;
        if (typeof version === "string" && version !== "") return version;
      }
    }
    return AGENT_VERSION;
  });

export const machineName = (): string => hostname() || "machine";

export const isAbsoluteProjectPath = isAbsolutePath;
export const pathExists = fileExists;
