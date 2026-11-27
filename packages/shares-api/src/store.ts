import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Context, Effect, Option, Schema } from "effect";

type D1Raw = Effect.Success<Cloudflare.D1.QueryDatabaseClient["raw"]>;

/** Rows of `migrations/0001_shares.sql`. Owner and subscriber ids are opaque. */
export const ShareRow = Schema.Struct({
  id: Schema.String,
  ownerUserId: Schema.String,
  ownerMachineId: Schema.NullOr(Schema.String),
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

export const ShareSubscriptionRow = Schema.Struct({
  shareId: Schema.String,
  machineId: Schema.String,
  installedSha: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type ShareSubscriptionRow = typeof ShareSubscriptionRow.Type;

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
  readonly upsertSubscription: (row: ShareSubscriptionRow) => Effect.Effect<void>;
  readonly findSubscription: (
    shareId: string,
    machineId: string,
  ) => Effect.Effect<Option.Option<ShareSubscriptionRow>>;
  readonly deleteSubscription: (shareId: string, machineId: string) => Effect.Effect<void>;
  readonly listSubscriptionsByMachine: (
    machineId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly subscription: ShareSubscriptionRow; readonly share: ShareRow }>
  >;
  readonly listSubscribedMachines: (shareId: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly setInstalledSha: (
    shareId: string,
    machineId: string,
    sha: string,
    now: number,
  ) => Effect.Effect<void>;
}

export class ShareStore extends Context.Service<ShareStore, ShareStoreService>()(
  "Ballast/Shares/ShareStore",
) {}

const shareColumns = (prefix: string) =>
  [
    ["id", "id"],
    ["owner_user_id", "ownerUserId"],
    ["owner_machine_id", "ownerMachineId"],
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

const subscriptionColumns =
  "s.share_id AS shareId, s.machine_id AS machineId, s.installed_sha AS installedSha, s.created_at AS createdAt, s.updated_at AS updatedAt";

const decodeShare = Schema.decodeUnknownSync(ShareRow);
const decodeSubscription = Schema.decodeUnknownSync(ShareSubscriptionRow);

const prefixed = (row: unknown, prefix: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (typeof row !== "object" || row === null) return out;
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
};

export const makeD1ShareStore = (raw: D1Raw): ShareStoreService => {
  const first = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).first());
  const all = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).all());
  const run = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).run());
  const one = <A>(row: unknown | null, decode: (value: unknown) => A) =>
    row === null ? Option.none<A>() : Option.some(decode(row));

  return {
    insertShare: (row) =>
      run(
        "INSERT INTO shares (id, owner_user_id, owner_machine_id, name, repo, share_code, current_sha, manifest_hash, message, deployed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.ownerUserId,
        row.ownerMachineId,
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

    upsertSubscription: (row) =>
      run(
        "INSERT INTO share_subscriptions (share_id, machine_id, installed_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(share_id, machine_id) DO UPDATE SET updated_at = excluded.updated_at",
        row.shareId,
        row.machineId,
        row.installedSha,
        row.createdAt,
        row.updatedAt,
      ).pipe(Effect.asVoid),

    findSubscription: (shareId, machineId) =>
      first(
        "SELECT " +
          subscriptionColumns +
          " FROM share_subscriptions s WHERE s.share_id = ? AND s.machine_id = ?",
        shareId,
        machineId,
      ).pipe(Effect.map((row) => one(row, decodeSubscription))),

    deleteSubscription: (shareId, machineId) =>
      run(
        "DELETE FROM share_subscriptions WHERE share_id = ? AND machine_id = ?",
        shareId,
        machineId,
      ).pipe(Effect.asVoid),

    listSubscriptionsByMachine: (machineId) =>
      all(
        "SELECT " +
          subscriptionColumns +
          ", " +
          shareColumns("p_") +
          " FROM share_subscriptions s JOIN shares p ON p.id = s.share_id WHERE s.machine_id = ? ORDER BY s.created_at",
        machineId,
      ).pipe(
        Effect.map((result) =>
          result.results.map((row) => ({
            subscription: decodeSubscription(row),
            share: decodeShare(prefixed(row, "p_")),
          })),
        ),
      ),

    listSubscribedMachines: (shareId) =>
      all(
        "SELECT machine_id AS machineId FROM share_subscriptions WHERE share_id = ?",
        shareId,
      ).pipe(
        Effect.map((result) =>
          result.results.flatMap((row) => {
            const machineId = prefixed(row, "")["machineId"];
            return typeof machineId === "string" ? [machineId] : [];
          }),
        ),
      ),

    setInstalledSha: (shareId, machineId, sha, now) =>
      run(
        "UPDATE share_subscriptions SET installed_sha = ?, updated_at = ? WHERE share_id = ? AND machine_id = ?",
        sha,
        now,
        shareId,
        machineId,
      ).pipe(Effect.asVoid),
  };
};
