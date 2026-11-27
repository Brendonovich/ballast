import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Option, Schema } from "effect";

type D1Raw = Effect.Success<Cloudflare.D1.QueryDatabaseClient["raw"]>;

/**
 * Rows of `migrations/0002_share_users.sql` (after `0003`). The owner id is the front
 * door's user id (a signed-in person, decision 0014), stored opaquely.
 * Subscribers are anonymous: a share code is their read capability.
 */
export const ShareRow = Schema.Struct({
  id: Schema.String,
  ownerUserId: Schema.String,
  name: Schema.String,
  repo: Schema.String,
  shareCode: Schema.String,
  currentSha: Schema.NullOr(Schema.String),
  manifestHash: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  deployedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ShareRow = typeof ShareRow.Type;

export interface ShareStoreService {
  readonly insertShare: (row: ShareRow) => Effect.Effect<void>;
  readonly findShare: (id: string) => Effect.Effect<Option.Option<ShareRow>>;
  readonly findShareByCode: (
    shareCode: string,
  ) => Effect.Effect<Option.Option<ShareRow>>;
  /** Compare-and-set the current deploy; false when another deploy won. */
  readonly recordDeploy: (input: {
    readonly id: string;
    readonly expectedSha: string | null;
    readonly sha: string;
    readonly manifestHash: string;
    readonly message: string | null;
    readonly deployedAt: number;
  }) => Effect.Effect<boolean>;
}

export class ShareStore extends Context.Service<ShareStore, ShareStoreService>()(
  "Ballast/Shares/ShareStore",
) {}

const shareColumns = (prefix: string) =>
  [
    ["id", "id"],
    ["owner_user_id", "ownerUserId"],
    ["name", "name"],
    ["repo", "repo"],
    ["share_code", "shareCode"],
    ["current_sha", "currentSha"],
    ["manifest_hash", "manifestHash"],
    ["message", "message"],
    ["deployed_at", "deployedAt"],
    ["created_at", "createdAt"],
    ["updated_at", "updatedAt"],
  ]
    .map(([column, alias]) => "p." + column + " AS " + prefix + alias)
    .join(", ");

const decodeShare = Schema.decodeUnknownSync(ShareRow);

export const makeD1ShareStore = (raw: D1Raw): ShareStoreService => {
  const first = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).first());
  const run = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).run());
  const one = <A>(row: unknown | null, decode: (value: unknown) => A) =>
    row === null ? Option.none<A>() : Option.some(decode(row));

  return {
    insertShare: (row) =>
      run(
        "INSERT INTO shares (id, owner_user_id, name, repo, share_code, current_sha, manifest_hash, message, deployed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.ownerUserId,
        row.name,
        row.repo,
        row.shareCode,
        row.currentSha,
        row.manifestHash,
        row.message,
        row.deployedAt,
        row.createdAt,
        row.updatedAt,
      ).pipe(Effect.asVoid),

    findShare: (id) =>
      first("SELECT " + shareColumns("") + " FROM shares p WHERE p.id = ?", id).pipe(
        Effect.map((row) => one(row, decodeShare)),
      ),

    findShareByCode: (shareCode) =>
      first(
        "SELECT " + shareColumns("") + " FROM shares p WHERE p.share_code = ?",
        shareCode,
      ).pipe(Effect.map((row) => one(row, decodeShare))),

    recordDeploy: (input) =>
      run(
        input.expectedSha === null
          ? "UPDATE shares SET current_sha = ?, manifest_hash = ?, message = ?, deployed_at = ?, updated_at = ? WHERE id = ? AND current_sha IS NULL"
          : "UPDATE shares SET current_sha = ?, manifest_hash = ?, message = ?, deployed_at = ?, updated_at = ? WHERE id = ? AND current_sha = ?",
        input.sha,
        input.manifestHash,
        input.message,
        input.deployedAt,
        input.deployedAt,
        input.id,
        ...(input.expectedSha === null ? [] : [input.expectedSha]),
      ).pipe(Effect.map((result) => (result.meta.changes ?? 0) > 0)),

  };
};
