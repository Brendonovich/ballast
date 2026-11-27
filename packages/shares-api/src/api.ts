import {
  SHARE_MANIFEST_PATH,
  SHARE_MAX_TOTAL_BYTES,
  decodeShareManifest,
  diffShareManifests,
  encodeBase64,
  gitBlobSha,
  shareManifestHash,
  type ShareDiffFile,
  type ShareDiffResponse,
  type ShareManifest,
} from "@ballast/cloud-protocol";
import { Clock, Data, Effect, Option } from "effect";

import type { ShareRepoError, ShareReposService } from "./repos.ts";
import type { ShareRow, ShareStoreService } from "./store.ts";

/**
 * A failed shares API operation, with the HTTP status and error tag the
 * calling front door should answer with. It crosses the service binding as
 * a plain `{ _tag, ...fields }` object.
 */
export class SharesApiError extends Data.TaggedError("SharesApiError")<{
  readonly status: number;
  readonly tag: "invalid_request" | "not_found" | "conflict" | "upstream_error" | "internal";
  readonly message: string;
  readonly details?: { readonly currentSha?: string; readonly code?: string | null };
}> {}

export interface DeployToken {
  readonly remote: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly currentSha: string | null;
}

export interface RecordedDeploy {
  readonly share: ShareRow;
  readonly manifestHash: string;
  /** False when `sha` already was the current deploy (an idempotent retry). */
  readonly recorded: boolean;
  /** Machines subscribed to the share, to notify. */
  readonly subscribers: ReadonlyArray<string>;
}

export interface MachineSubscription {
  readonly share: ShareRow;
  readonly installedSha: string | null;
}

/**
 * The shares API's operations (decision 0013): share records,
 * repo storage, deploy validation and manifest diffs. It has no notion of
 * credentials; the Ballast cloud authenticates machines and decides who may
 * call what, then calls these over a service binding.
 */
// A type alias (not an interface) so it satisfies Worker's indexed RPC shape.
export type SharesApiRpc = {
  readonly createShare: (input: {
    readonly ownerUserId: string;
    readonly ownerMachineId: string | null;
    readonly name: string;
  }) => Effect.Effect<ShareRow, SharesApiError>;
  readonly getShare: (id: string) => Effect.Effect<ShareRow | null>;
  /** Codes are matched ignoring case, spaces and dashes. */
  readonly findShareByCode: (shareCode: string) => Effect.Effect<ShareRow | null>;
  readonly deployToken: (id: string) => Effect.Effect<DeployToken, SharesApiError>;
  readonly recordDeploy: (input: {
    readonly id: string;
    readonly sha: string;
    readonly message: string | null;
  }) => Effect.Effect<RecordedDeploy, SharesApiError>;
  readonly subscribe: (input: { readonly shareId: string; readonly machineId: string }) => Effect.Effect<void>;
  readonly unsubscribe: (input: { readonly shareId: string; readonly machineId: string }) => Effect.Effect<void>;
  readonly isSubscribed: (input: { readonly shareId: string; readonly machineId: string }) => Effect.Effect<boolean>;
  readonly listSubscriptions: (machineId: string) => Effect.Effect<ReadonlyArray<MachineSubscription>>;
  readonly setInstalledSha: (input: {
    readonly shareId: string;
    readonly machineId: string;
    readonly sha: string;
  }) => Effect.Effect<void>;
  /** Changed files between two deploys by commit SHA; `from` null is a full snapshot, `to` null the current deploy. */
  readonly diff: (input: {
    readonly id: string;
    readonly from: string | null;
    readonly to: string | null;
  }) => Effect.Effect<ShareDiffResponse, SharesApiError>;
};

const DEPLOY_TOKEN_TTL_SECONDS = 15 * 60;
const nameLimit = 100;
const shaPattern = /^[0-9a-f]{40}$/;
const shareAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const fail = (status: number, tag: SharesApiError["tag"], message: string, details?: SharesApiError["details"]) =>
  Effect.fail(new SharesApiError({ status, tag, message, ...(details === undefined ? {} : { details }) }));

const storageError = (error: ShareRepoError) =>
  new SharesApiError({
    status: 503,
    tag: "upstream_error",
    message: "Share storage failed: " + error.message,
    details: { code: error.code ?? null },
  });

/** Share codes are stored without dashes, shown as XXXX-XXXX-XXXX. */
export const normalizeShareCode = (value: string): string => value.toUpperCase().replace(/[\s-]/g, "");
export const formatShareCode = (code: string): string => code.match(/.{1,4}/g)?.join("-") ?? code;

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomShareCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    shareAlphabet.charAt(byte % shareAlphabet.length),
  ).join("");

export const makeSharesApi = (deps: {
  readonly store: ShareStoreService;
  /** Undefined when this deployment has no repo storage (`BALLAST_SHARES=off`). */
  readonly repos: ShareReposService | undefined;
}): SharesApiRpc => {
  const { store } = deps;

  const requireRepos =
    deps.repos === undefined
      ? fail(503, "upstream_error", "Project sharing is not configured on this Ballast cloud")
      : Effect.succeed(deps.repos);

  const share = (id: string) =>
    Effect.flatMap(store.findShare(id), (row) =>
      Option.isNone(row) ? fail(404, "not_found", "Unknown share") : Effect.succeed(row.value),
    );

  const readManifest = (repos: ShareReposService, row: ShareRow, sha: string) =>
    Effect.gen(function* () {
      const bytes = yield* repos.readFile(row.repo, sha, SHARE_MANIFEST_PATH).pipe(Effect.mapError(storageError));
      if (bytes === undefined) return undefined;
      return yield* decodeShareManifest(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError((error) => new SharesApiError({ status: 400, tag: "invalid_request", message: error.message })),
      );
    });

  return {
    createShare: (input) =>
      Effect.gen(function* () {
        const repos = yield* requireRepos;
        const name = input.name.trim();
        if (name.length === 0 || name.length > nameLimit)
          return yield* fail(400, "invalid_request", "Share name must be 1-" + nameLimit + " characters");
        const now = yield* Clock.currentTimeMillis;
        const suffix = randomHex(8);
        const row: ShareRow = {
          id: "shr_" + suffix,
          ownerUserId: input.ownerUserId,
          ownerMachineId: input.ownerMachineId,
          name,
          repo: "ballast-" + suffix,
          shareCode: randomShareCode(),
          currentSha: null,
          manifestHash: null,
          message: null,
          deployedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* repos.create(row.repo).pipe(Effect.mapError(storageError));
        yield* store.insertShare(row);
        return row;
      }),

    getShare: (id) => Effect.map(store.findShare(id), Option.getOrNull),

    findShareByCode: (shareCode) =>
      Effect.map(store.findShareByCode(normalizeShareCode(shareCode)), Option.getOrNull),

    deployToken: (id) =>
      Effect.gen(function* () {
        const repos = yield* requireRepos;
        const row = yield* share(id);
        const token = yield* repos.writeToken(row.repo, DEPLOY_TOKEN_TTL_SECONDS).pipe(Effect.mapError(storageError));
        return { ...token, currentSha: row.currentSha };
      }),

    recordDeploy: (input) =>
      Effect.gen(function* () {
        const repos = yield* requireRepos;
        const row = yield* share(input.id);
        if (row.currentSha === input.sha)
          return { share: row, manifestHash: row.manifestHash ?? "", recorded: false, subscribers: [] };
        const commit = yield* repos.readCommit(row.repo, input.sha).pipe(Effect.mapError(storageError));
        if (commit === undefined)
          return yield* fail(409, "conflict", "Commit " + input.sha + " is not in the share's repo; push it first");
        // Earlier deploys stay reachable from the new one, so any subscriber can still be diffed by SHA.
        if (row.currentSha !== null && !commit.parents.includes(row.currentSha))
          return yield* fail(409, "conflict", "A deploy must build on the current deploy " + row.currentSha, {
            currentSha: row.currentSha,
          });
        const manifest = yield* readManifest(repos, row, input.sha);
        if (manifest === undefined)
          return yield* fail(400, "invalid_request", "Commit " + input.sha + " has no " + SHARE_MANIFEST_PATH);
        const manifestHash = yield* shareManifestHash(manifest);
        const deployedAt = yield* Clock.currentTimeMillis;
        const recorded = yield* store.recordDeploy({
          id: row.id,
          expectedSha: row.currentSha,
          sha: input.sha,
          manifestHash,
          message: input.message,
          deployedAt,
        });
        if (!recorded) return yield* fail(409, "conflict", "Another deploy finished first; deploy again");
        return {
          share: { ...row, currentSha: input.sha, manifestHash, message: input.message, deployedAt, updatedAt: deployedAt },
          manifestHash,
          recorded: true,
          subscribers: yield* store.listSubscribedMachines(row.id),
        };
      }),

    subscribe: ({ shareId, machineId }) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        store.upsertSubscription({ shareId: shareId, machineId, installedSha: null, createdAt: now, updatedAt: now }),
      ),

    unsubscribe: ({ shareId, machineId }) => store.deleteSubscription(shareId, machineId),

    isSubscribed: ({ shareId, machineId }) =>
      Effect.map(store.findSubscription(shareId, machineId), Option.isSome),

    listSubscriptions: (machineId) =>
      Effect.map(store.listSubscriptionsByMachine(machineId), (rows) =>
        rows.map((row) => ({ share: row.share, installedSha: row.subscription.installedSha })),
      ),

    setInstalledSha: ({ shareId, machineId, sha }) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => store.setInstalledSha(shareId, machineId, sha, now)),

    diff: (input) =>
      Effect.gen(function* () {
        const repos = yield* requireRepos;
        const row = yield* share(input.id);
        const to = input.to ?? row.currentSha;
        if (to === null) return yield* fail(409, "conflict", "Nothing has been deployed to this share yet");
        if (!shaPattern.test(to) || (input.from !== null && !shaPattern.test(input.from)))
          return yield* fail(400, "invalid_request", "from/to must be 40-character commit SHAs");
        const target = yield* readManifest(repos, row, to);
        if (target === undefined) return yield* fail(404, "not_found", "No share at " + to);
        let base: ShareManifest | undefined;
        if (input.from !== null) {
          base = yield* readManifest(repos, row, input.from);
          if (base === undefined) return yield* fail(404, "not_found", "No share at " + input.from + "; fetch a full snapshot");
        }
        const changes = diffShareManifests(base, target);
        const bytes = changes.changed.reduce((total, entry) => total + entry.file.size, 0);
        if (bytes > SHARE_MAX_TOTAL_BYTES)
          return yield* fail(400, "invalid_request", "The share diff is larger than " + SHARE_MAX_TOTAL_BYTES + " bytes");
        const files: Array<ShareDiffFile> = [];
        for (const entry of changes.changed) {
          const content = yield* repos.readFile(row.repo, to, entry.path).pipe(Effect.mapError(storageError));
          if (content === undefined) return yield* fail(500, "internal", "Share " + to + " is missing " + entry.path);
          // Subscribers verify against the manifest; refuse a commit whose tree disagrees with it first.
          if ((yield* gitBlobSha(content)) !== entry.file.sha || content.byteLength !== entry.file.size)
            return yield* fail(500, "internal", "Share " + to + " does not match its manifest at " + entry.path);
          files.push({
            path: entry.path,
            sha: entry.file.sha,
            size: entry.file.size,
            mode: entry.file.mode,
            contentBase64: encodeBase64(content),
          });
        }
        return {
          shareId: row.id,
          from: input.from,
          to,
          message: to === row.currentSha ? row.message : null,
          manifest: target,
          files,
          deleted: [...changes.deleted],
        };
      }),
  };
};
