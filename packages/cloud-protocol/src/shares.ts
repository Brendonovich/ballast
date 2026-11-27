import { Data, Effect, Schema } from "effect";

/**
 * Project sharing (decision 0013). An author shares a project folder as
 * a git repo in the cloud; each deploy is one commit that carries a share
 * manifest. Subscribers download only the files that changed between two
 * commits, addressed by commit SHA, and verify every file against the
 * manifest's git blob SHA before swapping it in.
 *
 * "Share" is used instead of "artifact": artifacts are project UI pages
 * (decision 0011).
 */

/** The manifest's path inside every share commit. Never a project file. */
export const SHARE_MANIFEST_PATH = "ballast.share.json";

/** Directory names that are machine-local or generated and never shared. */
export const SHARE_EXCLUDED_DIRECTORIES: ReadonlyArray<string> = [
  ".ballast",
  ".git",
  "node_modules",
  "dist",
];

/**
 * File names that commonly hold machine secrets or OS litter: `.env`,
 * `.env.*` and `.DS_Store` are never shared, wherever they are.
 */
export const isShareExcludedFile = (name: string): boolean =>
  name === ".env" || name.startsWith(".env.") || name === ".DS_Store";

/** Under the 50k objects / 64 MiB per push and 32 MiB per file platform limits. */
export const SHARE_MAX_FILES = 2_000;
export const SHARE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SHARE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const GitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** Regular and executable files only: no symlinks or submodules. */
export const ShareFileMode = Schema.Literals(["100644", "100755"]);
export type ShareFileMode = typeof ShareFileMode.Type;

export const ShareManifestFile = Schema.Struct({
  /** Git blob SHA-1 of the file's bytes. */
  sha: GitSha,
  size: Schema.Number,
  mode: ShareFileMode,
});
export type ShareManifestFile = typeof ShareManifestFile.Type;

export const ShareManifest = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  /** Project-relative POSIX paths. */
  files: Schema.Record(Schema.String, ShareManifestFile),
});
export type ShareManifest = typeof ShareManifest.Type;

/**
 * A path a share may contain: relative, POSIX, no `.`/`..` or empty
 * segments, no excluded directory and not the manifest itself. Subscribers
 * write these paths under a project root, so this is the traversal guard.
 */
export const sharePathError = (path: string): string | undefined => {
  if (path.length === 0 || path.length > 512) return "path length must be 1-512";
  if (path.includes("\\") || path.includes("\0")) return "path must be POSIX without NUL";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "path must be relative";
  if (path === SHARE_MANIFEST_PATH) return "path is reserved for the share manifest";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      return "path has an empty, '.' or '..' segment";
    if (SHARE_EXCLUDED_DIRECTORIES.includes(segment))
      return "path is inside an excluded directory (" + segment + ")";
  }
  const name = segments[segments.length - 1] ?? "";
  if (isShareExcludedFile(name)) return "file name is never shared (" + name + ")";
  return undefined;
};

export class ShareManifestError extends Data.TaggedError("ShareManifestError")<{
  readonly message: string;
}> {}

/** Check limits and paths beyond what the schema expresses. */
export const validateShareManifest = (
  manifest: ShareManifest,
): Effect.Effect<ShareManifest, ShareManifestError> =>
  Effect.gen(function* () {
    const entries = Object.entries(manifest.files);
    if (entries.length > SHARE_MAX_FILES)
      return yield* new ShareManifestError({
        message: "A share may contain at most " + SHARE_MAX_FILES + " files",
      });
    let total = 0;
    const folded = new Map<string, string>();
    for (const [path, file] of entries) {
      const error = sharePathError(path);
      if (error !== undefined)
        return yield* new ShareManifestError({ message: path + ": " + error });
      if (!Number.isSafeInteger(file.size) || file.size < 0)
        return yield* new ShareManifestError({ message: path + ": invalid size" });
      if (file.size > SHARE_MAX_FILE_BYTES)
        return yield* new ShareManifestError({
          message: path + " is larger than " + SHARE_MAX_FILE_BYTES + " bytes",
        });
      // Two paths that differ only by case collide on macOS/Windows.
      const key = path.toLowerCase();
      const clash = folded.get(key);
      if (clash !== undefined)
        return yield* new ShareManifestError({
          message: path + " and " + clash + " differ only by case",
        });
      folded.set(key, path);
      total += file.size;
    }
    // A file cannot also be a directory that holds another file.
    for (const path of folded.values()) {
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const parent = segments.slice(0, index).join("/").toLowerCase();
        if (folded.has(parent))
          return yield* new ShareManifestError({
            message: path + " is inside " + folded.get(parent) + ", which is a file",
          });
      }
    }
    if (total > SHARE_MAX_TOTAL_BYTES)
      return yield* new ShareManifestError({
        message: "A share may contain at most " + SHARE_MAX_TOTAL_BYTES + " bytes",
      });
    return manifest;
  });

/** Stable bytes: sorted paths, so equal manifests hash equally. */
export const encodeShareManifest = (manifest: ShareManifest): string => {
  const files: Record<string, ShareManifestFile> = {};
  for (const path of Object.keys(manifest.files).sort()) {
    const file = manifest.files[path];
    if (file !== undefined) files[path] = { sha: file.sha, size: file.size, mode: file.mode };
  }
  return JSON.stringify({ version: manifest.version, name: manifest.name, files }, null, 2) + "\n";
};

export const decodeShareManifest = (
  text: string,
): Effect.Effect<ShareManifest, ShareManifestError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ShareManifest))(text).pipe(
    Effect.mapError(
      (cause) => new ShareManifestError({ message: "Invalid share manifest: " + cause.message }),
    ),
    Effect.flatMap(validateShareManifest),
  );

export interface ShareManifestDiff {
  /** Added or modified (content or mode), sorted by path. */
  readonly changed: ReadonlyArray<{ readonly path: string; readonly file: ShareManifestFile }>;
  readonly deleted: ReadonlyArray<string>;
  readonly unchanged: number;
}

/** `from` undefined means a full snapshot. */
export const diffShareManifests = (
  from: ShareManifest | undefined,
  to: ShareManifest,
): ShareManifestDiff => {
  const before = from?.files ?? {};
  const changed: Array<{ path: string; file: ShareManifestFile }> = [];
  let unchanged = 0;
  for (const path of Object.keys(to.files).sort()) {
    const file = to.files[path];
    if (file === undefined) continue;
    const previous = before[path];
    if (previous !== undefined && previous.sha === file.sha && previous.mode === file.mode) {
      unchanged += 1;
      continue;
    }
    changed.push({ path, file });
  }
  const deleted = Object.keys(before)
    .filter((path) => to.files[path] === undefined)
    .sort();
  return { changed, deleted, unchanged };
};

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Git's blob object id: SHA-1 of `blob <size>\0<bytes>`. Works in Node and Workers. */
export const gitBlobSha = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(() => {
    const header = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
    const buffer = new Uint8Array(header.byteLength + bytes.byteLength);
    buffer.set(header, 0);
    buffer.set(bytes, header.byteLength);
    return crypto.subtle.digest("SHA-1", buffer);
  }).pipe(Effect.map(hex));

/** SHA-256 of the canonical manifest bytes; recorded per deploy. */
export const shareManifestHash = (manifest: ShareManifest): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(encodeShareManifest(manifest))),
  ).pipe(Effect.map(hex));

// ---- HTTP API (machine-authenticated, `/api/shares/*`) ----

export const ShareInfo = Schema.Struct({
  shareId: Schema.String,
  name: Schema.String,
  /** The latest deployed commit; null until the first deploy. */
  currentSha: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  deployedAt: Schema.NullOr(Schema.Number),
  /** True when the calling machine's user owns the share. */
  owner: Schema.Boolean,
});
export type ShareInfo = typeof ShareInfo.Type;

export const CreateShareRequest = Schema.Struct({
  name: Schema.String,
});
export type CreateShareRequest = typeof CreateShareRequest.Type;

export const CreateShareResponse = Schema.Struct({
  share: ShareInfo,
  /** Unlisted capability: anyone with a paired machine and this code can subscribe. */
  shareCode: Schema.String,
});
export type CreateShareResponse = typeof CreateShareResponse.Type;

export const DeployTokenResponse = Schema.Struct({
  /** Git smart-HTTP remote for the share's repo. */
  remote: Schema.String,
  /** Basic-auth password for the push; short-lived and write-scoped. */
  token: Schema.String,
  expiresAt: Schema.String,
  currentSha: Schema.NullOr(Schema.String),
});
export type DeployTokenResponse = typeof DeployTokenResponse.Type;

export const FinalizeDeployRequest = Schema.Struct({
  sha: GitSha,
  message: Schema.optionalKey(Schema.String),
});
export type FinalizeDeployRequest = typeof FinalizeDeployRequest.Type;

export const FinalizeDeployResponse = Schema.Struct({
  share: ShareInfo,
  manifestHash: Schema.String,
  /** Subscribed machines that were sent a `share_update`. */
  notified: Schema.Number,
});
export type FinalizeDeployResponse = typeof FinalizeDeployResponse.Type;

export const SubscribeRequest = Schema.Struct({
  shareCode: Schema.String,
});
export type SubscribeRequest = typeof SubscribeRequest.Type;

export const SubscribeResponse = Schema.Struct({
  share: ShareInfo,
});
export type SubscribeResponse = typeof SubscribeResponse.Type;

export const ShareIdRequest = Schema.Struct({
  shareId: Schema.String,
});
export type ShareIdRequest = typeof ShareIdRequest.Type;

export const ReportInstalledRequest = Schema.Struct({
  shareId: Schema.String,
  sha: GitSha,
});
export type ReportInstalledRequest = typeof ReportInstalledRequest.Type;

export const ListShareSubscriptionsResponse = Schema.Struct({
  subscriptions: Schema.Array(
    Schema.Struct({
      share: ShareInfo,
      installedSha: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ListShareSubscriptionsResponse = typeof ListShareSubscriptionsResponse.Type;

export const ShareDiffFile = Schema.Struct({
  path: Schema.String,
  sha: GitSha,
  size: Schema.Number,
  mode: ShareFileMode,
  /** Standard base64 of the file bytes. */
  contentBase64: Schema.String,
});
export type ShareDiffFile = typeof ShareDiffFile.Type;

/**
 * `GET /api/shares/:id/diff?from=<sha>&to=<sha>`. `from`
 * omitted means a full snapshot; `to` omitted means the current deploy.
 */
export const ShareDiffResponse = Schema.Struct({
  shareId: Schema.String,
  from: Schema.NullOr(Schema.String),
  to: GitSha,
  message: Schema.NullOr(Schema.String),
  manifest: ShareManifest,
  files: Schema.Array(ShareDiffFile),
  deleted: Schema.Array(Schema.String),
});
export type ShareDiffResponse = typeof ShareDiffResponse.Type;

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

export const decodeBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
