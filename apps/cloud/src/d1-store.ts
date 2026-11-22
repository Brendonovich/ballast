import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer, Option, Schema } from "effect";

import {
  AccountSecrets,
  CloudStore,
  MachineRow,
  type CloudStoreService,
  type OAuthStateRow,
  type PairingCodeRow,
  type SubscriptionRow,
  type TwitchAccountRow,
} from "./store.ts";

type QueryDatabase = Cloudflare.D1.QueryDatabaseClient;
type D1Raw = Effect.Success<QueryDatabase["raw"]>;

const encodeJson = (value: unknown): string => JSON.stringify(value) ?? "null";

const encodeCondition = (condition: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(condition)
        .sort()
        .map((key) => [key, condition[key]]),
    ),
  );

const UserDb = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const AccountDb = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  twitchUserId: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  scopesJson: Schema.String,
  secretsJson: Schema.String,
  machineId: Schema.NullOr(Schema.String),
  needsReauth: Schema.Number,
  refreshLock: Schema.NullOr(Schema.String),
  refreshLockUntil: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const SubscriptionDb = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  machineId: Schema.String,
  type: Schema.String,
  version: Schema.Number,
  conditionJson: Schema.String,
  cost: Schema.Number,
  providerSubscriptionId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "enabled", "revoked", "error"]),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value);

const decodeJson = <A, I>(schema: Schema.Codec<A, I>, value: string): A =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(value);

const accountToValues = (row: TwitchAccountRow) => [
  row.id,
  row.userId,
  row.twitchUserId,
  row.login,
  row.displayName,
  encodeJson(row.scopes),
  encodeJson(row.secrets),
  row.machineId,
  row.needsReauth ? 1 : 0,
  row.refreshLock,
  row.refreshLockUntil,
  row.createdAt,
  row.updatedAt,
];

const accountFromDb = (row: unknown): TwitchAccountRow => {
  const decoded = decode(AccountDb, row);
  return {
    id: decoded.id,
    userId: decoded.userId,
    twitchUserId: decoded.twitchUserId,
    login: decoded.login,
    displayName: decoded.displayName,
    scopes: decodeJson(Schema.Array(Schema.String), decoded.scopesJson),
    secrets: decodeJson(AccountSecrets, decoded.secretsJson),
    machineId: decoded.machineId,
    needsReauth: decoded.needsReauth === 1,
    refreshLock: decoded.refreshLock,
    refreshLockUntil: decoded.refreshLockUntil,
    createdAt: decoded.createdAt,
    updatedAt: decoded.updatedAt,
  };
};

const subscriptionFromDb = (row: unknown): SubscriptionRow => {
  const decoded = decode(SubscriptionDb, row);
  return {
    id: decoded.id,
    accountId: decoded.accountId,
    machineId: decoded.machineId,
    type: decoded.type,
    version: decoded.version,
    condition: decodeJson(Schema.Record(Schema.String, Schema.String), decoded.conditionJson),
    cost: decoded.cost,
    providerSubscriptionId: decoded.providerSubscriptionId,
    status: decoded.status,
    onStale: decoded.onStale,
    maxAgeMs: decoded.maxAgeMs,
    lastError: decoded.lastError,
    createdAt: decoded.createdAt,
    updatedAt: decoded.updatedAt,
  };
};

const subscriptionToValues = (row: SubscriptionRow) => [
  row.id,
  row.accountId,
  row.machineId,
  row.type,
  row.version,
  encodeCondition(row.condition),
  row.cost,
  row.providerSubscriptionId,
  row.status,
  row.onStale,
  row.maxAgeMs,
  row.lastError,
  row.createdAt,
  row.updatedAt,
];

export const makeD1CloudStore = (raw: D1Raw): CloudStoreService => {
  const first = <A = unknown>(query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).first<A>());
  const all = <A = unknown>(query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).all<A>());
  const run = (query: string, ...values: ReadonlyArray<unknown>) =>
    Effect.promise(() => raw.prepare(query).bind(...values).run());

  const findOne = <A>(effect: Effect.Effect<unknown | null>, decodeRow: (row: unknown) => A) =>
    effect.pipe(
      Effect.map((row) => (row === null ? Option.none<A>() : Option.some(decodeRow(row)))),
    );

  return {
    insertOAuthState: (row) =>
      run(
        "INSERT INTO oauth_states (state, scopes_json, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(state) DO UPDATE SET scopes_json = excluded.scopes_json, redirect_uri = excluded.redirect_uri, created_at = excluded.created_at, expires_at = excluded.expires_at",
        row.state,
        encodeJson(row.scopes),
        row.redirectUri,
        row.createdAt,
        row.expiresAt,
      ).pipe(Effect.asVoid),

    takeOAuthState: (state, now) =>
      Effect.gen(function* () {
        const row = yield* first(
          "SELECT state, scopes_json AS scopesJson, redirect_uri AS redirectUri, created_at AS createdAt, expires_at AS expiresAt FROM oauth_states WHERE state = ?",
          state,
        );
        if (row === null) return Option.none<OAuthStateRow>();
        yield* run("DELETE FROM oauth_states WHERE state = ?", state);
        const decoded = decode(
          Schema.Struct({
            state: Schema.String,
            scopesJson: Schema.String,
            redirectUri: Schema.String,
            createdAt: Schema.Number,
            expiresAt: Schema.Number,
          }),
          row,
        );
        if (decoded.expiresAt <= now) return Option.none<OAuthStateRow>();
        return Option.some({
          state: decoded.state,
          scopes: decodeJson(Schema.Array(Schema.String), decoded.scopesJson),
          redirectUri: decoded.redirectUri,
          createdAt: decoded.createdAt,
          expiresAt: decoded.expiresAt,
        });
      }),

    upsertUser: (row) =>
      run(
        "INSERT INTO users (id, login, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET login = excluded.login, display_name = excluded.display_name, email = excluded.email, updated_at = excluded.updated_at",
        row.id,
        row.login,
        row.displayName,
        row.email,
        row.createdAt,
        row.updatedAt,
      ).pipe(Effect.asVoid),

    findUser: (id) =>
      findOne(
        first(
          "SELECT id, login, display_name AS displayName, email, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?",
          id,
        ),
        (row) => decode(UserDb, row),
      ),

    upsertTwitchAccount: (row) =>
      run(
        "INSERT INTO twitch_accounts (id, user_id, twitch_user_id, login, display_name, scopes_json, secrets_json, machine_id, needs_reauth, refresh_lock, refresh_lock_until, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, twitch_user_id = excluded.twitch_user_id, login = excluded.login, display_name = excluded.display_name, scopes_json = excluded.scopes_json, secrets_json = excluded.secrets_json, machine_id = excluded.machine_id, needs_reauth = excluded.needs_reauth, refresh_lock = excluded.refresh_lock, refresh_lock_until = excluded.refresh_lock_until, updated_at = excluded.updated_at",
        ...accountToValues(row),
      ).pipe(Effect.asVoid),

    findAccount: (id) =>
      findOne(
        first(
          "SELECT id, user_id AS userId, twitch_user_id AS twitchUserId, login, display_name AS displayName, scopes_json AS scopesJson, secrets_json AS secretsJson, machine_id AS machineId, needs_reauth AS needsReauth, refresh_lock AS refreshLock, refresh_lock_until AS refreshLockUntil, created_at AS createdAt, updated_at AS updatedAt FROM twitch_accounts WHERE id = ?",
          id,
        ),
        accountFromDb,
      ),

    findAccountByTwitchUser: (userId, twitchUserId) =>
      findOne(
        first(
          "SELECT id, user_id AS userId, twitch_user_id AS twitchUserId, login, display_name AS displayName, scopes_json AS scopesJson, secrets_json AS secretsJson, machine_id AS machineId, needs_reauth AS needsReauth, refresh_lock AS refreshLock, refresh_lock_until AS refreshLockUntil, created_at AS createdAt, updated_at AS updatedAt FROM twitch_accounts WHERE user_id = ? AND twitch_user_id = ?",
          userId,
          twitchUserId,
        ),
        accountFromDb,
      ),

    listAccountsByUser: (userId) =>
      all(
        "SELECT id, user_id AS userId, twitch_user_id AS twitchUserId, login, display_name AS displayName, scopes_json AS scopesJson, secrets_json AS secretsJson, machine_id AS machineId, needs_reauth AS needsReauth, refresh_lock AS refreshLock, refresh_lock_until AS refreshLockUntil, created_at AS createdAt, updated_at AS updatedAt FROM twitch_accounts WHERE user_id = ? ORDER BY created_at",
        userId,
      ).pipe(Effect.map((result) => result.results.map(accountFromDb))),

    updateAccountSecrets: (id, secrets, updatedAt, lockToken) =>
      run(
        lockToken === undefined
          ? "UPDATE twitch_accounts SET secrets_json = ?, updated_at = ? WHERE id = ?"
          : "UPDATE twitch_accounts SET secrets_json = ?, updated_at = ?, refresh_lock = NULL, refresh_lock_until = 0 WHERE id = ? AND refresh_lock = ?",
        ...(lockToken === undefined
          ? [encodeJson(secrets), updatedAt, id]
          : [encodeJson(secrets), updatedAt, id, lockToken]),
      ).pipe(Effect.map((result) => (result.meta.changes ?? 0) > 0)),

    updateAccountMachine: (id, machineId, updatedAt) =>
      run(
        "UPDATE twitch_accounts SET machine_id = ?, updated_at = ? WHERE id = ?",
        machineId,
        updatedAt,
        id,
      ).pipe(Effect.asVoid),

    setAccountNeedsReauth: (id, needsReauth, updatedAt) =>
      run(
        "UPDATE twitch_accounts SET needs_reauth = ?, updated_at = ? WHERE id = ?",
        needsReauth ? 1 : 0,
        updatedAt,
        id,
      ).pipe(Effect.asVoid),

    tryAcquireRefreshLock: (id, lockToken, now, lockUntil) =>
      run(
        "UPDATE twitch_accounts SET refresh_lock = ?, refresh_lock_until = ? WHERE id = ? AND (refresh_lock IS NULL OR refresh_lock_until <= ?)",
        lockToken,
        lockUntil,
        id,
        now,
      ).pipe(Effect.map((result) => (result.meta.changes ?? 0) > 0)),

    releaseRefreshLock: (id, lockToken) =>
      run(
        "UPDATE twitch_accounts SET refresh_lock = NULL, refresh_lock_until = 0 WHERE id = ? AND refresh_lock = ?",
        id,
        lockToken,
      ).pipe(Effect.asVoid),

    incrementRateLimit: ({ key, windowStart, expiresAt }) =>
      first<{ count: number }>(
        "INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 1, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET " +
          "count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, " +
          "window_start = excluded.window_start, expires_at = excluded.expires_at " +
          "RETURNING count",
        key,
        windowStart,
        expiresAt,
      ).pipe(
        Effect.map((row) => {
          if (row === null) throw new Error("rate_limits upsert returned no row");
          return row.count;
        }),
      ),

    pruneRateLimits: (before) =>
      run("DELETE FROM rate_limits WHERE expires_at < ?", before).pipe(Effect.asVoid),

    insertPairingCode: (row) =>
      run(
        "INSERT INTO pairing_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at, expires_at = excluded.expires_at",
        row.code,
        row.userId,
        row.createdAt,
        row.expiresAt,
      ).pipe(Effect.asVoid),

    takePairingCode: (code, now) =>
      Effect.gen(function* () {
        const row = yield* first(
          "SELECT code, user_id AS userId, created_at AS createdAt, expires_at AS expiresAt FROM pairing_codes WHERE code = ?",
          code,
        );
        if (row === null) return Option.none<PairingCodeRow>();
        yield* run("DELETE FROM pairing_codes WHERE code = ?", code);
        const decoded: PairingCodeRow = decode(
          Schema.Struct({
            code: Schema.String,
            userId: Schema.String,
            createdAt: Schema.Number,
            expiresAt: Schema.Number,
          }),
          row,
        );
        return decoded.expiresAt > now ? Option.some(decoded) : Option.none<PairingCodeRow>();
      }),

    insertMachine: (row) =>
      run(
        "INSERT INTO machines (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        row.id,
        row.userId,
        row.name,
        row.tokenHash,
        row.createdAt,
        row.lastSeenAt,
      ).pipe(Effect.asVoid),

    findMachine: (id) =>
      findOne(
        first(
          "SELECT id, user_id AS userId, name, token_hash AS tokenHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM machines WHERE id = ?",
          id,
        ),
        (row) => decode(MachineRow, row),
      ),

    findMachineByTokenHash: (tokenHash) =>
      findOne(
        first(
          "SELECT id, user_id AS userId, name, token_hash AS tokenHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM machines WHERE token_hash = ?",
          tokenHash,
        ),
        (row) => decode(MachineRow, row),
      ),

    touchMachine: (id, now) =>
      run("UPDATE machines SET last_seen_at = ? WHERE id = ?", now, id).pipe(Effect.asVoid),

    listSubscriptions: (accountId) =>
      all(
        "SELECT id, account_id AS accountId, machine_id AS machineId, type, version, condition_json AS conditionJson, cost, provider_subscription_id AS providerSubscriptionId, status, on_stale AS onStale, max_age_ms AS maxAgeMs, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM event_subscriptions WHERE account_id = ? ORDER BY created_at",
        accountId,
      ).pipe(Effect.map((result) => result.results.map(subscriptionFromDb))),

    findSubscriptionByProviderId: (providerId) =>
      findOne(
        first(
          "SELECT id, account_id AS accountId, machine_id AS machineId, type, version, condition_json AS conditionJson, cost, provider_subscription_id AS providerSubscriptionId, status, on_stale AS onStale, max_age_ms AS maxAgeMs, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM event_subscriptions WHERE provider_subscription_id = ?",
          providerId,
        ),
        subscriptionFromDb,
      ),

    upsertSubscription: (row) =>
      run(
        "INSERT INTO event_subscriptions (id, account_id, machine_id, type, version, condition_json, cost, provider_subscription_id, status, on_stale, max_age_ms, last_error, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET machine_id = excluded.machine_id, condition_json = excluded.condition_json, cost = excluded.cost, provider_subscription_id = excluded.provider_subscription_id, status = excluded.status, on_stale = excluded.on_stale, max_age_ms = excluded.max_age_ms, last_error = excluded.last_error, updated_at = excluded.updated_at",
        ...subscriptionToValues(row),
      ).pipe(Effect.asVoid),

    deleteSubscription: (id) =>
      run("DELETE FROM event_subscriptions WHERE id = ?", id).pipe(Effect.asVoid),

    markSubscriptionRevoked: (providerId, now, reason) =>
      run(
        reason === undefined
          ? "UPDATE event_subscriptions SET status = 'revoked', updated_at = ? WHERE provider_subscription_id = ?"
          : "UPDATE event_subscriptions SET status = 'revoked', last_error = ?, updated_at = ? WHERE provider_subscription_id = ?",
        ...(reason === undefined ? [now, providerId] : [reason, now, providerId]),
      ).pipe(Effect.asVoid),

    hasWebhookDelivery: (messageId) =>
      first("SELECT 1 AS found FROM webhook_deliveries WHERE message_id = ?", messageId).pipe(
        Effect.map((row) => row !== null),
      ),

    recordWebhookDelivery: (messageId, accountId, receivedAt) =>
      run(
        "INSERT INTO webhook_deliveries (message_id, account_id, received_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING",
        messageId,
        accountId,
        receivedAt,
      ).pipe(Effect.map((result) => (result.meta.changes ?? 0) > 0)),

    pruneWebhookDeliveries: (before) =>
      run("DELETE FROM webhook_deliveries WHERE received_at < ?", before).pipe(Effect.asVoid),
  };
};

export const layerD1CloudStore = (db: QueryDatabase) =>
  Layer.effect(
    CloudStore,
    Effect.gen(function* () {
      const raw = yield* db.raw;
      return CloudStore.of(makeD1CloudStore(raw));
    }),
  );
