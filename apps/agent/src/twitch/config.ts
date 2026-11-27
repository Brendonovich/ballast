import * as Config from "effect/Config";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OAuth } from "@ballast/module-twitch";
import { DEFAULT_TWITCH_CALLBACK_PORT } from "@ballast/agent-protocol";
import type { ConnectionOptions } from "../connection-config.ts";
import { ensureDir, readJson, writeJsonAtomic } from "../service/fs.ts";

export type TwitchMode = "auto" | "local" | "cloud";
export type TwitchTransportMode = "local-app" | "cloud";

type Environment = Readonly<Record<string, string | undefined>>;

const readEnvironment = (): Effect.Effect<Environment> =>
  Effect.forEach(
    ["BALLAST_DATA_DIR", "XDG_DATA_HOME", "LOCALAPPDATA", "HOME"],
    (key) =>
      Config.String(key).pipe(
        Config.option,
        Effect.orDie,
        Effect.map((value) => [key, Option.getOrUndefined(value)] as const),
      ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

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
export const resolveDataDir = (path: Path.Path, env: Environment): string => {
  const explicit = env["BALLAST_DATA_DIR"];
  if (explicit !== undefined && explicit !== "") {
    return path.resolve(explicit);
  }
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "") {
    return path.join(xdg, "ballast");
  }
  if (process.platform === "win32" && env["LOCALAPPDATA"] !== undefined) {
    return path.join(env["LOCALAPPDATA"], "ballast");
  }
  return path.join(env["HOME"] ?? "", ".local", "share", "ballast");
};

const sanitizeSlot = (slot: string): string =>
  slot.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");

export const twitchAccountPath = (
  path: Path.Path,
  slot: string,
  dataDir: string,
): string => path.join(dataDir, "twitch", "accounts", sanitizeSlot(slot) + ".json");

export const cloudPairingPath = (path: Path.Path, dataDir: string): string =>
  path.join(dataDir, "cloud.json");

const dataDirOf = (
  dataDir: string | undefined,
): Effect.Effect<string, never, Path.Path> =>
  dataDir === undefined
    ? Effect.gen(function* () {
        const path = yield* Path.Path;
        return resolveDataDir(path, yield* readEnvironment());
      })
    : Effect.succeed(dataDir);

export const decodeStoredTwitchAccount = (value: unknown): StoredTwitchAccount =>
  Schema.decodeUnknownSync(StoredTwitchAccountSchema)(value);

export const readStoredTwitchAccount = (
  slot: string,
  dataDir?: string,
): Effect.Effect<
  StoredTwitchAccount | undefined,
  unknown,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* dataDirOf(dataDir);
    const value = yield* readJson(twitchAccountPath(path, slot, root));
    return value === undefined ? undefined : decodeStoredTwitchAccount(value);
  });

export const writeStoredTwitchAccount = (
  account: StoredTwitchAccount,
  dataDir?: string,
): Effect.Effect<
  void,
  unknown,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* dataDirOf(dataDir);
    yield* writeJsonAtomic(twitchAccountPath(path, account.slot, root), account);
  });

export const decodeCloudPairing = (value: unknown): CloudPairing =>
  Schema.decodeUnknownSync(CloudPairingSchema)(value);

export const readCloudPairing = (
  dataDir?: string,
): Effect.Effect<CloudPairing | undefined, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* dataDirOf(dataDir);
    const value = yield* readJson(cloudPairingPath(path, root));
    return value === undefined ? undefined : decodeCloudPairing(value);
  });

export const writeCloudPairing = (
  pairing: CloudPairing,
  dataDir?: string,
): Effect.Effect<
  void,
  unknown,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* dataDirOf(dataDir);
    yield* ensureDir(root);
    yield* writeJsonAtomic(cloudPairingPath(path, root), pairing);
  });

/** Environment keys `resolveTwitchAppConfig` reads for one slot. */
export const twitchEnvKeys = (slot: string): ReadonlyArray<string> => [
  envKey("BALLAST_TWITCH_", slot, "_CLIENT_ID"),
  envKey("BALLAST_TWITCH_", slot, "_CLIENT_SECRET"),
  envKey("BALLAST_TWITCH_", slot, "_MODE"),
  envKey("BALLAST_TWITCH_", slot, "_CONNECTION"),
  "BALLAST_TWITCH_CLIENT_ID",
  "BALLAST_TWITCH_CLIENT_SECRET",
  "BALLAST_TWITCH_MODE",
  "BALLAST_TWITCH_CONNECTION",
  "BALLAST_TWITCH_CALLBACK_PORT",
  "BALLAST_TWITCH_AUTHORIZATION_URL",
  "BALLAST_TWITCH_TOKEN_URL",
  "BALLAST_TWITCH_VALIDATE_URL",
  "BALLAST_TWITCH_DEVICE_URL",
  "BALLAST_TWITCH_REVOKE_URL",
  "BALLAST_TWITCH_HELIX_URL",
  "BALLAST_TWITCH_EVENTSUB_URL",
];

const envString = (
  env: Environment,
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
  env: Environment,
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
    callbackPortValue === undefined
      ? DEFAULT_TWITCH_CALLBACK_PORT
      : Number(callbackPortValue);
  if (!Number.isInteger(callbackPort) || callbackPort <= 0) {
    throw new Error("BALLAST_TWITCH_CALLBACK_PORT must be a positive integer");
  }

  return {
    slot,
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    callbackPort,
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
  env: Environment,
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
