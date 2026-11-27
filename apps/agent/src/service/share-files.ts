import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  SHARE_EXCLUDED_DIRECTORIES,
  SHARE_MANIFEST_PATH,
  ShareManifest,
  gitBlobSha,
  isShareExcludedFile,
  sharePathError,
  validateShareManifest,
  type ShareFileMode,
  type ShareManifestFile,
} from "@ballast/cloud-protocol";

/**
 * Share files on disk (decision 0013): building a manifest from a project
 * folder, and applying a verified set of changed files to a subscribed copy
 * with a staging directory and a rollback journal.
 */
export class ShareFilesError extends Data.TaggedError("ShareFilesError")<{
  readonly message: string;
}> {}

/** Machine-local copy of the installed share manifest. */
export const INSTALLED_MANIFEST_FILE = "share-manifest.json";

export interface ShareFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: ShareFileMode;
  readonly sha: string;
}

const failure = (message: string) => new ShareFilesError({ message });

const errorText = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

const isSymbolicLink = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readLink(path).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );

/**
 * Every shareable file under `root`: excluded directories, `.env*`,
 * symlinks and the manifest path are skipped. Sorted by path.
 */
export const collectShareFiles = (
  root: string,
  /** Machine-specific files to leave out (for example generated tsconfigs). */
  skip: (path: string, bytes: Uint8Array) => boolean = () => false,
): Effect.Effect<ReadonlyArray<ShareFile>, ShareFilesError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: Array<ShareFile> = [];
    const walk = (directory: string): Effect.Effect<void, ShareFilesError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError((cause) => failure("Could not read " + directory + ": " + errorText(cause))));
        entries.sort((left, right) => left.localeCompare(right));
        for (const name of entries) {
          const absolute = path.join(directory, name);
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          if (yield* isSymbolicLink(absolute)) continue;
          const info = yield* fs.stat(absolute).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (info === undefined) continue;
          if (info.type === "Directory") {
            if (SHARE_EXCLUDED_DIRECTORIES.includes(name)) continue;
            yield* walk(absolute);
            continue;
          }
          if (info.type !== "File") continue;
          if (relative === SHARE_MANIFEST_PATH || isShareExcludedFile(name)) continue;
          const pathError = sharePathError(relative);
          if (pathError !== undefined) return yield* failure(relative + ": " + pathError);
          const bytes = yield* fs
            .readFile(absolute)
            .pipe(Effect.mapError((cause) => failure("Could not read " + relative + ": " + errorText(cause))));
          if (skip(relative, bytes)) continue;
          files.push({
            path: relative,
            bytes,
            mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
            sha: yield* gitBlobSha(bytes),
          });
        }
      });
    yield* walk(root);
    return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  });

export const manifestOf = (
  name: string,
  files: ReadonlyArray<ShareFile>,
): Effect.Effect<ShareManifest, ShareFilesError> => {
  const entries: Record<string, ShareManifestFile> = {};
  for (const file of files)
    entries[file.path] = { sha: file.sha, size: file.bytes.byteLength, mode: file.mode };
  return validateShareManifest({ version: 1, name, files: entries }).pipe(
    Effect.mapError((error) => failure(error.message)),
  );
};

const installedPath = (path: Path.Path, root: string): string =>
  path.join(root, ".ballast", INSTALLED_MANIFEST_FILE);

export const readInstalledManifest = (
  root: string,
): Effect.Effect<ShareManifest | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(installedPath(path, root))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) return undefined;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ShareManifest))(text).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
  });

export const writeInstalledManifest = (
  root: string,
  manifest: ShareManifest,
): Effect.Effect<void, ShareFilesError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = installedPath(path, root);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(target + ".tmp", JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    yield* fs.rename(target + ".tmp", target);
  }).pipe(Effect.mapError((cause) => failure("Could not record the installed share: " + errorText(cause))));

/**
 * Files whose bytes or mode no longer match the installed manifest (local
 * edits to a read-only copy). Missing files count as divergent.
 */
export const divergentFiles = (
  root: string,
  manifest: ShareManifest,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changed: Array<string> = [];
    for (const [relative, file] of Object.entries(manifest.files)) {
      const absolute = path.join(root, ...relative.split("/"));
      const bytes = yield* fs.readFile(absolute).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (bytes === undefined || (yield* gitBlobSha(bytes)) !== file.sha) changed.push(relative);
    }
    return changed.sort();
  });

const randomSuffix = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Apply a verified file set to `root`.
 *
 * 1. Every path is checked, every file is hashed against its expected git
 *    blob SHA, and written to a staging directory under `.ballast/` (same
 *    volume, so the swap is renames only). Staged files are read back and
 *    hashed again. Any failure here leaves the project untouched.
 * 2. The swap moves each existing target into a backup directory and the
 *    staged file into place, then moves deleted files to the backup. Each
 *    step is journaled; a failure rolls every completed step back in reverse,
 *    so the old files are restored.
 * 3. On success the backup and staging directories are removed and
 *    directories emptied by deletions are pruned.
 *
 * Multi-file atomicity relies on the caller pausing anything that watches
 * the folder (the service pauses its project sync) until this returns.
 */
export const applyShareFiles = (input: {
  readonly root: string;
  readonly files: ReadonlyArray<ShareFile>;
  readonly deleted: ReadonlyArray<string>;
}): Effect.Effect<void, ShareFilesError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(input.root);
    const target = (relative: string): Effect.Effect<string, ShareFilesError> => {
      const pathError = sharePathError(relative);
      if (pathError !== undefined) return Effect.fail(failure(relative + ": " + pathError));
      const absolute = path.resolve(root, ...relative.split("/"));
      return absolute.startsWith(root + path.sep)
        ? Effect.succeed(absolute)
        : Effect.fail(failure(relative + ": resolves outside the project"));
    };
    for (const file of input.files) yield* target(file.path);
    for (const relative of input.deleted) yield* target(relative);

    const work = path.join(root, ".ballast", "share-" + randomSuffix());
    const staging = path.join(work, "staging");
    const backup = path.join(work, "backup");
    const cleanup = fs.remove(work, { recursive: true }).pipe(Effect.ignore);
    const io = <A>(effect: Effect.Effect<A, unknown>, what: string) =>
      effect.pipe(Effect.mapError((cause) => failure(what + ": " + errorText(cause))));

    // 1. Stage and verify.
    yield* Effect.gen(function* () {
      for (const file of input.files) {
        if ((yield* gitBlobSha(file.bytes)) !== file.sha)
          return yield* failure(file.path + " does not match its share hash");
        const staged = path.join(staging, ...file.path.split("/"));
        yield* io(fs.makeDirectory(path.dirname(staged), { recursive: true, mode: 0o755 }), "Could not stage " + file.path);
        yield* io(
          fs.writeFile(staged, file.bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 }),
          "Could not stage " + file.path,
        );
        yield* io(fs.chmod(staged, file.mode === "100755" ? 0o755 : 0o644), "Could not stage " + file.path);
        const written = yield* io(fs.readFile(staged), "Could not verify " + file.path);
        if ((yield* gitBlobSha(written)) !== file.sha)
          return yield* failure(file.path + " was corrupted while staging");
      }
    }).pipe(Effect.tapError(() => cleanup));

    // 2. Swap with a journal.
    type Step =
      | { readonly kind: "backed-up"; readonly from: string; readonly to: string }
      | { readonly kind: "placed"; readonly at: string; readonly staged: string };
    const journal: Array<Step> = [];
    const exists = (absolute: string) =>
      fs.exists(absolute).pipe(Effect.catch(() => Effect.succeed(false)));
    const moveToBackup = (relative: string, absolute: string) =>
      Effect.gen(function* () {
        if (!(yield* exists(absolute))) return;
        const saved = path.join(backup, ...relative.split("/"));
        yield* io(fs.makeDirectory(path.dirname(saved), { recursive: true }), "Could not back up " + relative);
        yield* io(fs.rename(absolute, saved), "Could not back up " + relative);
        journal.push({ kind: "backed-up", from: absolute, to: saved });
      });
    const rollback = Effect.gen(function* () {
      for (const step of [...journal].reverse()) {
        if (step.kind === "placed") yield* fs.rename(step.at, step.staged).pipe(Effect.ignore);
        else yield* fs.rename(step.to, step.from).pipe(Effect.ignore);
      }
    });
    yield* Effect.gen(function* () {
      for (const file of input.files) {
        const absolute = yield* target(file.path);
        yield* moveToBackup(file.path, absolute);
        yield* io(fs.makeDirectory(path.dirname(absolute), { recursive: true, mode: 0o755 }), "Could not write " + file.path);
        const staged = path.join(staging, ...file.path.split("/"));
        yield* io(fs.rename(staged, absolute), "Could not write " + file.path);
        journal.push({ kind: "placed", at: absolute, staged });
      }
      for (const relative of input.deleted) {
        yield* moveToBackup(relative, yield* target(relative));
      }
    }).pipe(Effect.tapError(() => rollback.pipe(Effect.andThen(cleanup))));

    // 3. Commit.
    yield* cleanup;
    for (const relative of input.deleted) {
      let directory = path.dirname(yield* target(relative));
      while (directory.startsWith(root + path.sep)) {
        const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (entries === undefined || entries.length > 0) break;
        // Checked empty above; recursive is how `rm` removes a directory.
        yield* fs.remove(directory, { recursive: true }).pipe(Effect.ignore);
        directory = path.dirname(directory);
      }
    }
  });
