import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ensureDir, readJson, removeFile, writeJsonAtomic, fileExists } from "./fs.ts";

export const AGENT_NAME = "ballast-agent" as const;
export const AGENT_VERSION = "0.1.0-dev.20261123" as const;
export const SERVICE_SCHEMA_VERSION = 1 as const;

export interface ServeOptions {
  readonly port: number;
  readonly dev: boolean;
  readonly supervised: boolean;
  readonly standalone: boolean;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly webDir: string | undefined;
  readonly logDir: string | undefined;
  readonly cloudUrl: string | undefined;
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

const isAbsolutePath = (path: string): boolean =>
  isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);

export const resolveStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (env["BALLAST_STATE_DIR"] !== undefined && env["BALLAST_STATE_DIR"] !== "") {
    return resolve(env["BALLAST_STATE_DIR"]);
  }
  if (env["XDG_STATE_HOME"] !== undefined && env["XDG_STATE_HOME"] !== "") {
    return join(env["XDG_STATE_HOME"], "ballast");
  }
  if (process.platform === "win32" && env["LOCALAPPDATA"] !== undefined) {
    return join(env["LOCALAPPDATA"], "Ballast", "state");
  }
  return join(homedir(), ".local", "state", "ballast");
};

export const resolveDataDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (env["BALLAST_DATA_DIR"] !== undefined && env["BALLAST_DATA_DIR"] !== "") {
    return resolve(env["BALLAST_DATA_DIR"]);
  }
  if (env["XDG_DATA_HOME"] !== undefined && env["XDG_DATA_HOME"] !== "") {
    return join(env["XDG_DATA_HOME"], "ballast");
  }
  if (process.platform === "win32" && env["LOCALAPPDATA"] !== undefined) {
    return join(env["LOCALAPPDATA"], "Ballast");
  }
  return join(homedir(), ".local", "share", "ballast");
};

const defaultWebDirs = (): ReadonlyArray<string> => [
  fileURLToPath(new URL("../../../web/dist", import.meta.url)),
  join(dirname(fileURLToPath(import.meta.url)), "web"),
  join(process.cwd(), "web"),
];

export const resolveWebDir = (
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const configured = explicit ?? env["BALLAST_WEB_DIR"];
  if (configured !== undefined && configured !== "") return resolve(configured);
  const candidates = defaultWebDirs();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
};

export const parseServeOptions = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServeOptions => {
  let port = env["BALLAST_SERVICE_PORT"] === undefined
    ? 0
    : parsePort(env["BALLAST_SERVICE_PORT"]);
  let dev = false;
  let supervised = false;
  let standalone = false;
  let stateDir: string | undefined;
  let dataDir: string | undefined;
  let webDir: string | undefined;
  let logDir = env["BALLAST_LOG_DIR"];
  let cloudUrl = env["BALLAST_CLOUD_URL"];

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
    if (arg === "--standalone") {
      standalone = true;
      continue;
    }
    if (arg === "--state-dir") {
      stateDir = resolve(value("--state-dir"));
      continue;
    }
    if (arg !== undefined && arg.startsWith("--state-dir=")) {
      stateDir = resolve(arg.slice("--state-dir=".length));
      continue;
    }
    if (arg === "--data-dir") {
      dataDir = resolve(value("--data-dir"));
      continue;
    }
    if (arg !== undefined && arg.startsWith("--data-dir=")) {
      dataDir = resolve(arg.slice("--data-dir=".length));
      continue;
    }
    if (arg === "--web-dir") {
      webDir = resolve(value("--web-dir"));
      continue;
    }
    if (arg !== undefined && arg.startsWith("--web-dir=")) {
      webDir = resolve(arg.slice("--web-dir=".length));
      continue;
    }
    if (arg === "--log-dir") {
      logDir = resolve(value("--log-dir"));
      continue;
    }
    if (arg !== undefined && arg.startsWith("--log-dir=")) {
      logDir = resolve(arg.slice("--log-dir=".length));
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
    standalone,
    stateDir: stateDir ?? resolveStateDir(env),
    dataDir: dataDir ?? resolveDataDir(env),
    webDir: resolveWebDir(webDir, env),
    logDir: logDir === undefined || logDir === "" ? undefined : resolve(logDir),
    cloudUrl: cloudUrl === undefined || cloudUrl === "" ? undefined : cloudUrl,
  };
};

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

export const serviceJsonPath = (stateDir: string): string => join(stateDir, "service.json");
export const serviceLockPath = (stateDir: string): string => join(stateDir, "service.lock");

export const makeServiceToken = (): string => randomBytes(32).toString("base64url");

export const readServiceRegistration = async (
  stateDir: string,
): Promise<ServiceRegistration | undefined> => {
  const value = await readJson(serviceJsonPath(stateDir));
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
};

export const writeServiceRegistration = async (
  stateDir: string,
  registration: ServiceRegistration,
): Promise<void> => {
  await ensureDir(stateDir, 0o700);
  await writeJsonAtomic(serviceJsonPath(stateDir), registration, 0o600);
};

export const writeServiceLock = async (stateDir: string, pid: number): Promise<void> => {
  await ensureDir(stateDir, 0o700);
  await writeJsonAtomic(serviceLockPath(stateDir), { pid, startedAt: Date.now() }, 0o600);
};

export const readServiceLock = async (stateDir: string): Promise<ServiceLock | undefined> => {
  const value = await readJson(serviceLockPath(stateDir));
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record["pid"] === "number"
    ? { pid: record["pid"], startedAt: typeof record["startedAt"] === "number" ? record["startedAt"] : 0 }
    : undefined;
};

export const clearServiceFiles = (stateDir: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await removeFile(serviceJsonPath(stateDir));
      await removeFile(serviceLockPath(stateDir));
    },
    catch: () => undefined,
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

/** Acquire the single-service lock, replacing a stale one. */
export const acquireLock = async (stateDir: string): Promise<void> => {
  await ensureDir(stateDir, 0o700);
  const existing = await readServiceLock(stateDir);
  if (existing !== undefined && processAlive(existing.pid)) {
    const registration = await readServiceRegistration(stateDir);
    const healthy =
      registration !== undefined && (await probeHealth(registration.url));
    if (healthy) {
      throw new ServeConfigError({
        message: `A Ballast service is already running (pid ${existing.pid}).`,
      });
    }
  }
  await writeServiceLock(stateDir, process.pid);
};

export const tokenEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Stable hash used for cookie/session comparisons without storing the token. */
export const tokenDigest = (token: string): string =>
  createHash("sha256").update(token).digest("base64url");

export const hostAllowed = (host: string | undefined, port: number, dev: boolean): boolean => {
  if (host === undefined || host === "") return false;
  const allowed = [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ];
  if (dev) {
    allowed.push("localhost:5173", "127.0.0.1:5173");
  }
  return allowed.includes(host);
};

export const originAllowed = (
  origin: string | undefined,
  port: number,
  dev: boolean,
): boolean => {
  if (origin === undefined || origin === "") return true;
  const allowed = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
  if (dev) {
    allowed.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  return allowed.includes(origin);
};

export const resolveServiceVersion = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> => {
  if (env["BALLAST_SERVICE_VERSION"] !== undefined && env["BALLAST_SERVICE_VERSION"] !== "") {
    return env["BALLAST_SERVICE_VERSION"];
  }
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "version.json"),
    join(fileURLToPath(new URL("../..", import.meta.url)), "version.json"),
  ];
  for (const candidate of candidates) {
    const value = await readJson(candidate);
    if (typeof value === "object" && value !== null) {
      const version = (value as { version?: unknown }).version;
      if (typeof version === "string" && version !== "") return version;
    }
  }
  return AGENT_VERSION;
};

export const machineName = (): string => hostname() || basename(homedir());

export const nodeHttpServerOptions = (
  options: ServeOptions,
): { readonly host: "127.0.0.1"; readonly port: number } => ({
  host: "127.0.0.1",
  port: options.port,
});

export const httpServerFactory = () => createServer();

export const isAbsoluteProjectPath = isAbsolutePath;
export const pathExists = fileExists;
