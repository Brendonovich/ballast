import { join, resolve } from "node:path";

/** Options accepted before the MCP transport takes over stdio. */
export interface McpConfig {
  /** Explicit data directory (connections, projects.json, secrets). */
  readonly dataDir: string | undefined;
  /** Explicit state directory containing service.json. */
  readonly stateDir: string | undefined;
  /** Explicit service URL/token pair, for tests and remote debugging. */
  readonly serviceUrl: string | undefined;
  readonly serviceToken: string | undefined;
}

export interface ParseConfigInput {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const homeOf = (input: ParseConfigInput): string =>
  nonEmpty(input.env["HOME"]) ?? nonEmpty(input.env["USERPROFILE"]) ?? input.home;

export const defaultStateDir = (input: Omit<ParseConfigInput, "args">): string => {
  const explicit = nonEmpty(input.env["BALLAST_STATE_DIR"]);
  if (explicit !== undefined) return resolve(explicit);
  const xdg = nonEmpty(input.env["XDG_STATE_HOME"]);
  if (input.platform === "win32") {
    const localAppData = nonEmpty(input.env["LOCALAPPDATA"]) ??
      join(homeOf({ ...input, args: [] }), "AppData", "Local");
    return join(localAppData, "Ballast", "state");
  }
  if (xdg !== undefined) return join(xdg, "ballast");
  return join(homeOf({ ...input, args: [] }), ".local", "state", "ballast");
};

export const defaultDataDir = (input: Omit<ParseConfigInput, "args">): string => {
  const explicit = nonEmpty(input.env["BALLAST_DATA_DIR"]);
  if (explicit !== undefined) return resolve(explicit);
  const xdg = nonEmpty(input.env["XDG_DATA_HOME"]);
  if (input.platform === "win32") {
    const localAppData = nonEmpty(input.env["LOCALAPPDATA"]) ??
      join(homeOf({ ...input, args: [] }), "AppData", "Local");
    return join(localAppData, "Ballast");
  }
  if (xdg !== undefined) return join(xdg, "ballast");
  return join(homeOf({ ...input, args: [] }), ".local", "share", "ballast");
};

const takeValue = (
  args: ReadonlyArray<string>,
  index: number,
  name: string,
): { readonly value: string; readonly next: number } => {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(name + " requires a value");
  }
  return { value: next, next: index + 1 };
};

/**
 * Parse the MCP process arguments. Only discovery options are accepted; stdio
 * is reserved for the MCP transport.
 */
export const parseConfig = (input: ParseConfigInput): McpConfig => {
  let dataDir = nonEmpty(input.env["BALLAST_DATA_DIR"]);
  let stateDir = nonEmpty(input.env["BALLAST_STATE_DIR"]);
  let serviceUrl = nonEmpty(input.env["BALLAST_SERVICE_URL"]);
  let serviceToken = nonEmpty(input.env["BALLAST_SERVICE_TOKEN"]);

  for (let index = 0; index < input.args.length; index++) {
    const arg = input.args[index];
    if (arg === undefined) continue;
    if (arg === "--data-dir") {
      const taken = takeValue(input.args, index, arg);
      dataDir = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
      continue;
    }
    if (arg === "--state-dir") {
      const taken = takeValue(input.args, index, arg);
      stateDir = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("--state-dir=")) {
      stateDir = arg.slice("--state-dir=".length);
      continue;
    }
    if (arg === "--url" || arg === "--service-url") {
      const taken = takeValue(input.args, index, arg);
      serviceUrl = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("--url=")) {
      serviceUrl = arg.slice("--url=".length);
      continue;
    }
    if (arg.startsWith("--service-url=")) {
      serviceUrl = arg.slice("--service-url=".length);
      continue;
    }
    if (arg === "--token" || arg === "--service-token") {
      const taken = takeValue(input.args, index, arg);
      serviceToken = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("--token=")) {
      serviceToken = arg.slice("--token=".length);
      continue;
    }
    if (arg.startsWith("--service-token=")) {
      serviceToken = arg.slice("--service-token=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h" || arg === "--version") {
      continue;
    }
    throw new Error('Unknown option "' + arg + '"');
  }

  return {
    dataDir: dataDir === undefined ? undefined : resolve(dataDir),
    stateDir: stateDir === undefined ? undefined : resolve(stateDir),
    serviceUrl: serviceUrl === undefined ? undefined : serviceUrl.replace(/\/+$/, ""),
    serviceToken,
  };
};

const appSupportFallbacks = (input: ParseConfigInput): ReadonlyArray<string> => {
  const home = homeOf(input);
  if (input.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Ballast", "state"),
      join(home, "Library", "Application Support", "Ballast"),
      join(home, "Library", "Application Support", "ballast", "state"),
    ];
  }
  if (input.platform === "win32") {
    const appData = nonEmpty(input.env["APPDATA"]) ?? join(home, "AppData", "Roaming");
    return [join(appData, "Ballast", "state"), join(appData, "Ballast")];
  }
  return [];
};

/**
 * Directories to inspect for service.json, in priority order. A data dir is
 * checked both directly and with a `state` child because the CLI keeps state
 * and data separate while older installs used one root.
 */
export const discoveryCandidates = (
  config: McpConfig,
  input: ParseConfigInput,
): ReadonlyArray<string> => {
  const candidates: Array<string> = [];
  const push = (path: string) => {
    const resolved = resolve(path);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  if (config.stateDir !== undefined) push(config.stateDir);
  if (config.dataDir !== undefined) {
    push(join(config.dataDir, "state"));
    push(config.dataDir);
  }
  if (config.stateDir === undefined && config.dataDir === undefined) {
    push(defaultStateDir(input));
    push(defaultDataDir(input));
  }
  for (const fallback of appSupportFallbacks(input)) push(fallback);
  return candidates;
};

export const isLoopbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

export const configSummary = (config: McpConfig): string => {
  const parts: Array<string> = [];
  if (config.serviceUrl !== undefined) parts.push("service " + config.serviceUrl);
  if (config.stateDir !== undefined) parts.push("state " + config.stateDir);
  if (config.dataDir !== undefined) parts.push("data " + config.dataDir);
  return parts.length === 0 ? "auto-discovery" : parts.join(", ");
};

export const configForUsage = (): string =>
  [
    "ballast-mcp [--state-dir <dir>] [--data-dir <dir>] [--url <url> --token <token>]",
    "",
    "The server speaks MCP over stdio and discovers the running Ballast service",
    "through service.json. It does not start Ballast.",
    "",
    "Environment: BALLAST_STATE_DIR, BALLAST_DATA_DIR, BALLAST_SERVICE_URL,",
    "BALLAST_SERVICE_TOKEN, XDG_STATE_HOME, XDG_DATA_HOME.",
  ].join("\n");
