import path from "node:path";

/** Everything the launcher needs, resolved from Electron/OS inputs once at startup. */
export interface DesktopConfig {
  readonly appId: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appPath: string;
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly stageRoot: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly serviceBuildDir: string;
  readonly serviceVersion: string | undefined;
  readonly uiUrl: string | undefined;
  readonly servicePort: number | undefined;
  /** Verification budget for a newly started service (BALLAST_START_TIMEOUT_MS). */
  readonly startTimeoutMs: number;
}

export interface ConfigInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly appVersion: string;
}

const envValue = (env: Readonly<Record<string, string | undefined>>, key: string): string | undefined => {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
};

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  return value;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 30_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) return 30_000;
  return value;
}

/** Pure config resolution; all filesystem/Electron lookups happen in the caller. */
export function resolveConfig(input: ConfigInput): DesktopConfig {
  const { env, platform } = input;
  const p = platform === "win32" ? path.win32 : path.posix;

  const appId = envValue(env, "BALLAST_APP_ID") ?? "dev.ballast.agent";

  const userDataDir = p.resolve(envValue(env, "BALLAST_USER_DATA_DIR") ?? input.userDataDir);
  const homeDir = p.resolve(input.homeDir);

  const stateDir = p.resolve(
    envValue(env, "BALLAST_STATE_DIR") ??
      (platform === "win32"
        ? p.join(envValue(env, "LOCALAPPDATA") ?? p.join(homeDir, "AppData", "Local"), "Ballast", "state")
        : p.join(envValue(env, "XDG_STATE_HOME") ?? p.join(homeDir, ".local", "state"), "ballast")),
  );

  const dataDir = p.resolve(
    envValue(env, "BALLAST_DATA_DIR") ??
      (platform === "win32"
        ? p.join(envValue(env, "LOCALAPPDATA") ?? p.join(homeDir, "AppData", "Local"), "ballast")
        : p.join(envValue(env, "XDG_DATA_HOME") ?? p.join(homeDir, ".local", "share"), "ballast")),
  );

  const serviceBuildDir = p.resolve(
    envValue(env, "BALLAST_SERVICE_BUILD_DIR") ??
      (input.isPackaged
        ? p.join(input.resourcesPath, "service")
        : p.join(input.appPath, "..", "agent", "dist-service")),
  );

  return {
    appId,
    appVersion: input.appVersion,
    platform,
    arch: input.arch,
    isPackaged: input.isPackaged,
    execPath: input.execPath,
    appPath: input.appPath,
    homeDir,
    userDataDir,
    stageRoot: p.join(userDataDir, "service"),
    stateDir,
    dataDir,
    logDir: p.resolve(envValue(env, "BALLAST_LOG_DIR") ?? p.join(userDataDir, "logs")),
    serviceBuildDir,
    serviceVersion: envValue(env, "BALLAST_SERVICE_VERSION"),
    uiUrl: envValue(env, "BALLAST_UI_URL"),
    servicePort: parsePort(envValue(env, "BALLAST_SERVICE_PORT")),
    startTimeoutMs: parseTimeout(envValue(env, "BALLAST_START_TIMEOUT_MS")),
  };
}
