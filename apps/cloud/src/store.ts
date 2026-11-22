import { Context, Effect, Option, Schema } from "effect";

import { WebhookStaticResponse } from "@ballast/cloud-protocol";

import { SealedSecret } from "./secrets.ts";

export const UserRow = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  email: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type UserRow = typeof UserRow.Type;

export const AccountSecrets = Schema.Struct({
  refreshToken: SealedSecret,
  accessToken: Schema.NullOr(SealedSecret),
  accessTokenExpiresAt: Schema.Number,
  webhookSecret: SealedSecret,
});
export type AccountSecrets = typeof AccountSecrets.Type;

export const TwitchAccountRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  twitchUserId: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  scopes: Schema.Array(Schema.String),
  secrets: AccountSecrets,
  machineId: Schema.NullOr(Schema.String),
  /** Set when Twitch revoked the authorization and the user must reconnect. */
  needsReauth: Schema.Boolean,
  /** Token-refresh lease holder. Only this value may commit refreshed secrets. */
  refreshLock: Schema.NullOr(Schema.String),
  refreshLockUntil: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type TwitchAccountRow = typeof TwitchAccountRow.Type;

export const MachineRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  name: Schema.String,
  tokenHash: Schema.String,
  createdAt: Schema.Number,
  lastSeenAt: Schema.Number,
});
export type MachineRow = typeof MachineRow.Type;

export const PairingCodeRow = Schema.Struct({
  code: Schema.String,
  userId: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type PairingCodeRow = typeof PairingCodeRow.Type;

export const OAuthStateRow = Schema.Struct({
  state: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type OAuthStateRow = typeof OAuthStateRow.Type;

export const SubscriptionRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  machineId: Schema.String,
  type: Schema.String,
  version: Schema.Number,
  condition: Schema.Record(Schema.String, Schema.String),
  cost: Schema.Number,
  providerSubscriptionId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "enabled", "revoked", "error"]),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type SubscriptionRow = typeof SubscriptionRow.Type;

/**
 * One client (project/script) that wants a provider subscription to exist.
 * Provider subscriptions are shared; an owner link carries that client's
 * freshness policy. The row is deleted when the last owner goes away.
 */
export const SubscriptionOwnerRow = Schema.Struct({
  subscriptionId: Schema.String,
  owner: Schema.String,
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type SubscriptionOwnerRow = typeof SubscriptionOwnerRow.Type;

/** Verification config stored in D1; the secret lives in a sealed column. */
export const HookVerificationConfig = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("shared-secret"),
    header: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("hmac-sha256"),
    header: Schema.String,
    encoding: Schema.Literals(["hex", "base64"]),
    prefix: Schema.optionalKey(Schema.String),
    timestampHeader: Schema.optionalKey(Schema.String),
    toleranceSeconds: Schema.optionalKey(Schema.Number),
  }),
]);
export type HookVerificationConfig = typeof HookVerificationConfig.Type;

export const WebhookHookRow = Schema.Struct({
  id: Schema.String,
  machineId: Schema.String,
  hookId: Schema.String,
  label: Schema.NullOr(Schema.String),
  verification: Schema.NullOr(HookVerificationConfig),
  secret: Schema.NullOr(SealedSecret),
  response: Schema.NullOr(WebhookStaticResponse),
  maxAgeMs: Schema.Number,
  onStale: Schema.Literals(["drop", "deliver"]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type WebhookHookRow = typeof WebhookHookRow.Type;

/**
 * Durable storage for everything except relay buffers. Relay buffers live in
 * the per-machine Durable Object so hot event traffic never touches D1.
 */
export interface CloudStoreService {
  // OAuth states
  readonly insertOAuthState: (row: OAuthStateRow) => Effect.Effect<void>;
  readonly takeOAuthState: (
    state: string,
    now: number,
  ) => Effect.Effect<Option.Option<OAuthStateRow>>;

  // Users and Twitch connections
  readonly upsertUser: (row: UserRow) => Effect.Effect<void>;
  readonly findUser: (id: string) => Effect.Effect<Option.Option<UserRow>>;
  readonly upsertTwitchAccount: (row: TwitchAccountRow) => Effect.Effect<void>;
  readonly findAccount: (id: string) => Effect.Effect<Option.Option<TwitchAccountRow>>;
  readonly findAccountByTwitchUser: (
    userId: string,
    twitchUserId: string,
  ) => Effect.Effect<Option.Option<TwitchAccountRow>>;
  readonly listAccountsByUser: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<TwitchAccountRow>>;
  /**
   * Commit refreshed token material. When `lockToken` is provided the update
   * only applies while that token still holds the account's refresh lease,
   * returning false if another request took over. Returns true otherwise.
   */
  readonly updateAccountSecrets: (
    id: string,
    secrets: AccountSecrets,
    updatedAt: number,
    lockToken?: string,
  ) => Effect.Effect<boolean>;
  readonly updateAccountMachine: (
    id: string,
    machineId: string | null,
    updatedAt: number,
  ) => Effect.Effect<void>;
  readonly setAccountNeedsReauth: (
    id: string,
    needsReauth: boolean,
    updatedAt: number,
  ) => Effect.Effect<void>;

  /**
   * Acquire the per-account refresh lease if it is free or expired. The lease
   * stops two Workers refreshing the same rotating refresh token at once.
   */
  readonly tryAcquireRefreshLock: (
    id: string,
    lockToken: string,
    now: number,
    lockUntil: number,
  ) => Effect.Effect<boolean>;
  readonly releaseRefreshLock: (
    id: string,
    lockToken: string,
  ) => Effect.Effect<void>;

  // Generic webhooks
  readonly listHooks: (machineId: string) => Effect.Effect<ReadonlyArray<WebhookHookRow>>;
  readonly findHook: (
    machineId: string,
    hookId: string,
  ) => Effect.Effect<Option.Option<WebhookHookRow>>;
  /** Replace the complete hook set for one machine. */
  readonly replaceHooks: (
    machineId: string,
    rows: ReadonlyArray<WebhookHookRow>,
  ) => Effect.Effect<void>;
  readonly deleteHooks: (machineId: string, hookIds: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly pruneHooks: (before: number) => Effect.Effect<void>;

  // Pairing and machines
  readonly insertPairingCode: (row: PairingCodeRow) => Effect.Effect<void>;
  readonly takePairingCode: (
    code: string,
    now: number,
  ) => Effect.Effect<Option.Option<PairingCodeRow>>;
  readonly insertMachine: (row: MachineRow) => Effect.Effect<void>;
  readonly findMachine: (id: string) => Effect.Effect<Option.Option<MachineRow>>;
  readonly findMachineByTokenHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<MachineRow>>;
  readonly touchMachine: (id: string, now: number) => Effect.Effect<void>;

  // Rate limits
  /**
   * Increment a fixed-window counter and return the new count. Starting a new
   * window resets the count to one.
   */
  readonly incrementRateLimit: (input: {
    readonly key: string;
    readonly windowStart: number;
    readonly expiresAt: number;
  }) => Effect.Effect<number>;
  readonly pruneRateLimits: (before: number) => Effect.Effect<void>;

  // EventSub subscriptions
  readonly listSubscriptions: (accountId: string) => Effect.Effect<ReadonlyArray<SubscriptionRow>>;
  readonly findSubscriptionByProviderId: (
    providerId: string,
  ) => Effect.Effect<Option.Option<SubscriptionRow>>;
  readonly upsertSubscription: (row: SubscriptionRow) => Effect.Effect<void>;
  readonly deleteSubscription: (id: string) => Effect.Effect<void>;
  readonly listSubscriptionOwners: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<SubscriptionOwnerRow>>;
  readonly upsertSubscriptionOwner: (row: SubscriptionOwnerRow) => Effect.Effect<void>;
  readonly deleteSubscriptionOwner: (
    subscriptionId: string,
    owner: string,
  ) => Effect.Effect<void>;
  readonly markSubscriptionRevoked: (
    providerId: string,
    now: number,
    reason?: string,
  ) => Effect.Effect<void>;

  // Webhook dedupe
  readonly hasWebhookDelivery: (messageId: string) => Effect.Effect<boolean>;
  readonly recordWebhookDelivery: (
    messageId: string,
    accountId: string,
    receivedAt: number,
  ) => Effect.Effect<boolean>;
  readonly pruneWebhookDeliveries: (before: number) => Effect.Effect<void>;
}

export class CloudStore extends Context.Service<CloudStore, CloudStoreService>()(
  "Ballast/CloudStore",
) {}
