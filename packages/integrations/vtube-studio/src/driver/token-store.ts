import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TOKEN_DIRECTORY } from "../constants.ts";
import { VTubeStudioStorageError } from "./errors.ts";

/**
 * The approved plugin token. VTube Studio only asks the user once; the token
 * is valid until they revoke the plugin, so it is stored per connection slot
 * (not per URL) and reused on every reconnect.
 */
export const StoredTokenSchema = Schema.Struct({
  version: Schema.Literal(1),
  slot: Schema.String,
  url: Schema.String,
  pluginName: Schema.String,
  pluginDeveloper: Schema.String,
  authenticationToken: Schema.String,
  updatedAt: Schema.Number,
});
export type StoredVTubeStudioToken = Schema.Schema.Type<typeof StoredTokenSchema>;

export interface VTubeStudioTokenStore {
  readonly read: (
    slot: string,
  ) => Effect.Effect<StoredVTubeStudioToken | undefined, VTubeStudioStorageError>;
  readonly write: (token: StoredVTubeStudioToken) => Effect.Effect<void, VTubeStudioStorageError>;
  readonly remove: (slot: string) => Effect.Effect<void, VTubeStudioStorageError>;
}

/**
 * Where Ballast keeps local state, matching `apps/agent/src/twitch/config.ts`.
 * The agent passes its own `dataDir`, so this default only serves standalone
 * use and tests.
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

const sanitizeSlot = (slot: string): string => slot.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");

export const tokenPath = (slot: string, dataDir = resolveDataDir()): string =>
  join(dataDir, TOKEN_DIRECTORY, "tokens", sanitizeSlot(slot) + ".json");

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

/** `<data>/ballast/vtube-studio/tokens/<slot>.json`, 0600, atomically replaced. */
export const fileTokenStore = (dataDir = resolveDataDir()): VTubeStudioTokenStore => ({
  read: (slot) =>
    Effect.gen(function* () {
      const path = tokenPath(slot, dataDir);
      const text = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(path, "utf8");
          } catch (cause) {
            if (isNotFound(cause)) return undefined;
            throw cause;
          }
        },
        catch: (cause) =>
          new VTubeStudioStorageError({
            message: "Could not read " + path + ": " + String(cause),
          }),
      });
      if (text === undefined) return undefined;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        yield* Effect.logWarning("Ignoring invalid VTube Studio token file " + path);
        return undefined;
      }

      const decoded = Schema.decodeUnknownOption(StoredTokenSchema)(parsed);
      if (Option.isNone(decoded)) {
        yield* Effect.logWarning("Ignoring invalid VTube Studio token file " + path);
        return undefined;
      }
      return decoded.value;
    }),

  write: (token) =>
    Effect.gen(function* () {
      const path = tokenPath(token.slot, dataDir);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temporary = path + "." + process.pid + ".tmp";
          await writeFile(temporary, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
          await rename(temporary, path);
        },
        catch: (cause) =>
          new VTubeStudioStorageError({
            message: "Could not write " + path + ": " + String(cause),
          }),
      });
    }),

  remove: (slot) =>
    Effect.gen(function* () {
      const path = tokenPath(slot, dataDir);
      yield* Effect.tryPromise({
        try: () => rm(path, { force: true }),
        catch: (cause) =>
          new VTubeStudioStorageError({
            message: "Could not remove " + path + ": " + String(cause),
          }),
      });
    }),
});
