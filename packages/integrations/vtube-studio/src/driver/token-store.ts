import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
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
  ) => Effect.Effect<
    StoredVTubeStudioToken | undefined,
    VTubeStudioStorageError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly write: (
    token: StoredVTubeStudioToken,
  ) => Effect.Effect<
    void,
    VTubeStudioStorageError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >;
  readonly remove: (
    slot: string,
  ) => Effect.Effect<void, VTubeStudioStorageError, FileSystem.FileSystem | Path.Path>;
}

type Environment = Readonly<Record<string, string | undefined>>;

const readEnvironment = (): Effect.Effect<Environment> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, string | undefined]> = [];
    for (const key of ["BALLAST_DATA_DIR", "XDG_DATA_HOME", "LOCALAPPDATA", "HOME"]) {
      const value = yield* Config.String(key).pipe(Config.option, Effect.orDie);
      entries.push([key, Option.getOrUndefined(value)] as const);
    }
    return Object.fromEntries(entries);
  });

/**
 * Where Ballast keeps local state, matching `apps/agent/src/service/config.ts`.
 * The agent passes its own `dataDir`, so this default only serves standalone
 * use and tests.
 */
export const resolveDataDir = (
  path: Path.Path,
  env: Environment,
): string => {
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

const sanitizeSlot = (slot: string): string => slot.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");

export const tokenPath = (path: Path.Path, slot: string, dataDir: string): string =>
  path.join(dataDir, TOKEN_DIRECTORY, "tokens", sanitizeSlot(slot) + ".json");

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "PlatformError" &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

const dataDirOf = (
  path: Path.Path,
  dataDir: string | undefined,
): Effect.Effect<string> =>
  dataDir === undefined
    ? Effect.map(readEnvironment(), (env) => resolveDataDir(path, env))
    : Effect.succeed(dataDir);

/** `<data>/ballast/vtube-studio/tokens/<slot>.json`, 0600, atomically replaced. */
export const fileTokenStore = (dataDir?: string): VTubeStudioTokenStore => {
  const pathFor = (slot: string): Effect.Effect<string, VTubeStudioStorageError, Path.Path> =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* dataDirOf(path, dataDir);
      return tokenPath(path, slot, root);
    }).pipe(
      Effect.mapError(
        (cause) => new VTubeStudioStorageError({ message: String(cause) }),
      ),
    );

  return {
    read: (slot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* pathFor(slot);
        const text = yield* fs.readFileString(path).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          Effect.mapError(
            (cause) =>
              new VTubeStudioStorageError({
                message: "Could not read " + path + ": " + String(cause),
              }),
          ),
        );
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
        const fs = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const paths = yield* Path.Path;
        const path = yield* pathFor(token.slot);
        const temporary = path + "." + Hex.encode(yield* crypto.randomBytes(4).pipe(Effect.orDie)) + ".tmp";
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(temporary, JSON.stringify(token, null, 2) + "\n", {
            mode: 0o600,
          });
          yield* fs.rename(temporary, path);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new VTubeStudioStorageError({
                message: "Could not write " + path + ": " + String(cause),
              }),
          ),
        );
      }),

    remove: (slot) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* pathFor(slot);
        yield* fs.remove(path, { force: true }).pipe(
          Effect.mapError(
            (cause) =>
              new VTubeStudioStorageError({
                message: "Could not remove " + path + ": " + String(cause),
              }),
          ),
        );
      }),
  };
};
