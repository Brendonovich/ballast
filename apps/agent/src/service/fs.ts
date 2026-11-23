import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Hex from "effect/encoding/Hex";

/**
 * Platform error check for "the entry does not exist". Effect normalizes every
 * platform failure into `PlatformError`, so callers no longer have to match
 * Node's `ENOENT` codes.
 */
export const isNotFound = (cause: unknown): boolean =>
  PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound";

export const ensureDir = (
  path: string,
  mode = 0o700,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeDirectory(path, { recursive: true, mode }),
  );

export const readJson = (
  path: string,
): Effect.Effect<
  unknown | undefined,
  PlatformError.PlatformError | Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
    );
    if (text === undefined) return undefined;
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        new Error(
          `Could not parse ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
  });

export const readText = (
  path: string,
): Effect.Effect<
  string | undefined,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined))),
  );

const temporaryName = (
  path: string,
): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const bytes = yield* crypto.randomBytes(4);
    return `${path}.${Hex.encode(bytes)}.tmp`;
  });

/**
 * Write JSON atomically with restrictive permissions. The temporary file is
 * renamed over the target, so a crash never leaves a partial document.
 */
export const writeJsonAtomic = (
  path: string,
  value: unknown,
  mode = 0o600,
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);

export const writeTextAtomic = (
  path: string,
  value: string,
  mode = 0o600,
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = yield* temporaryName(path);
    yield* fs.writeFileString(temporary, value, { mode });
    yield* fs.rename(temporary, path);
  });

export const removeFile = (
  path: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.remove(path, { force: true }),
  );

export const fileExists = (
  path: string,
): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));

export const contentHash = (
  content: string,
): Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(content));
    return Hex.encode(digest).slice(0, 16);
  });
