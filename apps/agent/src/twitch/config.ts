import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as Schema from "effect/Schema";

import { OAuth } from "@ballast/module-twitch";
import type { ConnectionOptions } from "../connection-config.ts";

export type TwitchMode = "auto" | "local" | "cloud";
export type TwitchTransportMode = "local-app" | "cloud";

const StoredTwitchAccountSchema = Schema.Struct({
  version: Schema.Literal(1),
  slot: Schema.String,
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scopes: Schema.Array(Schema.String),
  userId: Schema.String,
  login: Schema.String,
  displayName: Schema.optional(Schema.String),
});
export type StoredTwitchAccount = Schema.Schema.Type<typeof StoredTwitchAccountSchema>;

const PairedUserSchema = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
});
export type PairedUser = Schema.Schema.Type<typeof PairedUserSchema>;

const CloudPairingSchema = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String,
  machineId: Schema.String,
  machineToken: Schema.String,
  user: PairedUserSchema,
  pairedAt: Schema.Number,
  /** slot -> cloud Twitch connection id. */
  bindings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type CloudPairing = Schema.Schema.Type<typeof CloudPairingSchema>;

export interface TwitchModeOptions {
  /** Slot (or "twitch/<slot>") -> mode; the "" key is the global default. */
  readonly twitchModes: ReadonlyMap<string, TwitchMode>;
  readonly cloudUrl?: string;
}

export interface TwitchEndpointConfig {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly validateUrl: string;
  readonly deviceUrl: string;
  readonly revokeUrl: string;
  readonly helixBaseUrl: string;
  readonly eventSubUrl: string;
}

export interface TwitchAppConfig extends TwitchEndpointConfig {
  readonly slot: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  /** Fixed localhost callback port; Twitch requires an exact redirect URI. */
  readonly callbackPort?: number;
}

const envKey = (prefix: string, slot: string, suffix: string): string =>
  prefix + slot.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_") + suffix;

/**
 * Where Ballast keeps local state. Override with `BALLAST_DATA_DIR`.
 *
 * Tokens are plain JSON for now; moving them to the OS keychain is planned and
 * documented in docs/integrations/twitch.md.
 */
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
    return join(env["LOCALAPPDATA"], "ballast");
  }
  return join(homedir(), ".local", "share", "ballast");
};

const sanitizeSlot = (slot: string): string =>
  slot.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");

export const twitchAccountPath = (slot: string, dataDir = resolveDataDir()): string =>
  join(dataDir, "twitch", "accounts", sanitizeSlot(slot) + ".json");

export const cloudPairingPath = (dataDir = resolveDataDir()): string =>
  join(dataDir, "cloud.json");

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const readJson = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
};

export const decodeStoredTwitchAccount = (value: unknown): StoredTwitchAccount =>
  Schema.decodeUnknownSync(StoredTwitchAccountSchema)(value);

export const readStoredTwitchAccount = async (
  slot: string,
  dataDir = resolveDataDir(),
): Promise<StoredTwitchAccount | undefined> => {
  const value = await readJson(twitchAccountPath(slot, dataDir));
  return value === undefined ? undefined : decodeStoredTwitchAccount(value);
};

export const writeStoredTwitchAccount = async (
  account: StoredTwitchAccount,
  dataDir = resolveDataDir(),
): Promise<void> => {
  await writeJson(twitchAccountPath(account.slot, dataDir), account);
};

export const decodeCloudPairing = (value: unknown): CloudPairing =>
  Schema.decodeUnknownSync(CloudPairingSchema)(value);

export const readCloudPairing = async (
  dataDir = resolveDataDir(),
): Promise<CloudPairing | undefined> => {
  const value = await readJson(cloudPairingPath(dataDir));
  return value === undefined ? undefined : decodeCloudPairing(value);
};

export const writeCloudPairing = async (
  pairing: CloudPairing,
  dataDir = resolveDataDir(),
): Promise<void> => {
  await writeJson(cloudPairingPath(dataDir), pairing);
};

const envString = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined => {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
};

/**
 * Resolve the user's own Twitch application for one slot.
 *
 * Precedence for the client id:
 * 1. `--connection twitch/<slot>=<client id>`
 * 2. `BALLAST_TWITCH_<SLOT>_CLIENT_ID`
 * 3. `BALLAST_TWITCH_CLIENT_ID` (one app for every slot)
 * 4. the client id saved by `ballast auth twitch <slot>`
 *
 * The client secret is only read from `--connection-secret` or the matching
 * environment variables; it is never written to the token file.
 */
export const resolveTwitchAppConfig = (
  slot: string,
  options: ConnectionOptions,
  stored: StoredTwitchAccount | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TwitchAppConfig => {
  const clientId =
    options.connections.get("twitch/" + slot) ??
    envString(env, envKey("BALLAST_TWITCH_", slot, "_CLIENT_ID")) ??
    envString(env, "BALLAST_TWITCH_CLIENT_ID") ??
    stored?.clientId;
  if (clientId === undefined || clientId === "") {
    throw new Error(
      "Twitch connection twitch/" +
        slot +
        " needs the user's app client id. Pass --connection twitch/" +
        slot +
        "=<client id>, set BALLAST_TWITCH_" +
        slot.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_") +
        "_CLIENT_ID, or run ballast auth twitch " +
        slot +
        " with --connection twitch/" +
        slot +
        "=<client id>.",
    );
  }

  const clientSecret =
    options.secrets.get("twitch/" + slot) ??
    envString(env, envKey("BALLAST_TWITCH_", slot, "_CLIENT_SECRET")) ??
    envString(env, "BALLAST_TWITCH_CLIENT_SECRET");

  const callbackPortValue = envString(env, "BALLAST_TWITCH_CALLBACK_PORT");
  const callbackPort =
    callbackPortValue === undefined ? undefined : Number(callbackPortValue);
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 0)) {
    throw new Error("BALLAST_TWITCH_CALLBACK_PORT must be a non-negative integer");
  }

  return {
    slot,
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(callbackPort === undefined ? {} : { callbackPort }),
    authorizationUrl:
      envString(env, "BALLAST_TWITCH_AUTHORIZATION_URL") ??
      OAuth.DEFAULT_AUTHORIZATION_URL,
    tokenUrl: envString(env, "BALLAST_TWITCH_TOKEN_URL") ?? OAuth.DEFAULT_TOKEN_URL,
    validateUrl: envString(env, "BALLAST_TWITCH_VALIDATE_URL") ?? OAuth.DEFAULT_VALIDATE_URL,
    deviceUrl: envString(env, "BALLAST_TWITCH_DEVICE_URL") ?? OAuth.DEFAULT_DEVICE_URL,
    revokeUrl: envString(env, "BALLAST_TWITCH_REVOKE_URL") ?? OAuth.DEFAULT_REVOKE_URL,
    helixBaseUrl:
      envString(env, "BALLAST_TWITCH_HELIX_URL") ?? "https://api.twitch.tv/helix",
    eventSubUrl:
      envString(env, "BALLAST_TWITCH_EVENTSUB_URL") ?? "wss://eventsub.wss.twitch.tv/ws",
  };
};

export const oauthConfigOf = (config: TwitchAppConfig): OAuth.OAuthConfig => ({
  clientId: config.clientId,
  ...(config.clientSecret === undefined ? {} : { clientSecret: config.clientSecret }),
  authorizationUrl: config.authorizationUrl,
  tokenUrl: config.tokenUrl,
  validateUrl: config.validateUrl,
  deviceUrl: config.deviceUrl,
  revokeUrl: config.revokeUrl,
});

export const isTwitchMode = (value: string): value is TwitchMode =>
  value === "auto" || value === "local" || value === "cloud";

/**
 * Per-connection mode selection. Decision 0002: `either` means cloud when the
 * machine is paired, otherwise the user's own app. The user can force either
 * mode with `--twitch-mode` or `BALLAST_TWITCH_<SLOT>_MODE`.
 */
export const resolveTwitchMode = (
  slot: string,
  options: TwitchModeOptions,
  paired: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TwitchMode => {
  const fromOptions =
    options.twitchModes.get("twitch/" + slot) ?? options.twitchModes.get(slot);
  const fromEnv =
    envString(env, envKey("BALLAST_TWITCH_", slot, "_MODE")) ??
    envString(env, "BALLAST_TWITCH_MODE");
  let envMode: TwitchMode | undefined;
  if (fromEnv !== undefined) {
    if (isTwitchMode(fromEnv)) {
      envMode = fromEnv;
    } else {
      console.warn(
        "[twitch:" +
          slot +
          "] ignoring invalid mode '" +
          fromEnv +
          "'; expected auto, local or cloud",
      );
    }
  }
  const selected = fromOptions ?? envMode ?? "auto";
  if (selected === "auto") return paired ? "cloud" : "local";
  return selected;
};
