import { Context, Effect, Option, Schema } from "effect";

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
  readonly updateAccountSecrets: (
    id: string,
    secrets: AccountSecrets,
    updatedAt: number,
  ) => Effect.Effect<void>;
  readonly updateAccountMachine: (
    id: string,
    machineId: string | null,
    updatedAt: number,
  ) => Effect.Effect<void>;

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

  // EventSub subscriptions
  readonly listSubscriptions: (accountId: string) => Effect.Effect<ReadonlyArray<SubscriptionRow>>;
  readonly findSubscriptionByProviderId: (
    providerId: string,
  ) => Effect.Effect<Option.Option<SubscriptionRow>>;
  readonly upsertSubscription: (row: SubscriptionRow) => Effect.Effect<void>;
  readonly deleteSubscription: (id: string) => Effect.Effect<void>;
  readonly markSubscriptionRevoked: (
    providerId: string,
    now: number,
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
