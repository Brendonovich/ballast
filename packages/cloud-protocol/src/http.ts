import { Schema } from "effect";
import { EventEnvelope } from "./events.ts";

export const TwitchScopes = Schema.Array(Schema.String);

/**
 * A subscription the agent wants the cloud to maintain with Twitch.
 *
 * `condition` is Twitch's EventSub condition object, e.g.
 * `{ broadcaster_user_id: "123" }`.
 */
export const TwitchSubscriptionSpec = Schema.Struct({
  type: Schema.String,
  version: Schema.Number,
  condition: Schema.Record(Schema.String, Schema.String),
  onStale: Schema.Literals(["drop", "deliver"]),
  maxAgeMs: Schema.Number,
});
export type TwitchSubscriptionSpec = typeof TwitchSubscriptionSpec.Type;

export const TwitchSubscriptionStatus = Schema.Literals([
  "pending",
  "enabled",
  "revoked",
  "error",
]);
export type TwitchSubscriptionStatus = typeof TwitchSubscriptionStatus.Type;

export const TwitchSubscription = Schema.Struct({
  id: Schema.String,
  providerSubscriptionId: Schema.NullOr(Schema.String),
  type: Schema.String,
  version: Schema.Number,
  condition: Schema.Record(Schema.String, Schema.String),
  status: TwitchSubscriptionStatus,
  cost: Schema.Number,
  /** Client-supplied owners currently keeping this provider subscription alive. */
  owners: Schema.optionalKey(Schema.Array(Schema.String)),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type TwitchSubscription = typeof TwitchSubscription.Type;

export const TwitchConnection = Schema.Struct({
  id: Schema.String,
  twitchUserId: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  scopes: Schema.Array(Schema.String),
  machineId: Schema.NullOr(Schema.String),
  /** The user must reconnect this Twitch account before subscriptions work again. */
  needsReauth: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.Number,
});
export type TwitchConnection = typeof TwitchConnection.Type;

export const PairedUser = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
});
export type PairedUser = typeof PairedUser.Type;

// ---- Pairing ----

export const PairingClaimRequest = Schema.Struct({
  code: Schema.String,
  machineName: Schema.String,
  platform: Schema.optionalKey(Schema.String),
});
export type PairingClaimRequest = typeof PairingClaimRequest.Type;

export const PairingClaimResponse = Schema.Struct({
  machineId: Schema.String,
  machineToken: Schema.String,
  user: PairedUser,
});
export type PairingClaimResponse = typeof PairingClaimResponse.Type;

export const PairingCodeResponse = Schema.Struct({
  pairingCode: Schema.String,
  expiresAt: Schema.Number,
  userId: Schema.String,
  accountId: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
});
export type PairingCodeResponse = typeof PairingCodeResponse.Type;

// ---- Tokens ----

export const TwitchTokenRequest = Schema.Struct({
  connectionId: Schema.String,
});
export type TwitchTokenRequest = typeof TwitchTokenRequest.Type;

export const TwitchTokenResponse = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
  scopes: Schema.Array(Schema.String),
  twitchUserId: Schema.String,
  login: Schema.String,
});
export type TwitchTokenResponse = typeof TwitchTokenResponse.Type;

// ---- Helix proxy ----

export const HelixMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HelixMethod = typeof HelixMethod.Type;

export const HelixRequest = Schema.Struct({
  connectionId: Schema.String,
  method: HelixMethod,
  path: Schema.String,
  query: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  body: Schema.optionalKey(Schema.Json),
  /**
   * Scopes the caller believes this call needs. The cloud checks they are a
   * subset of the connection's granted scopes before using its token.
   */
  scopes: Schema.Array(Schema.String),
});
export type HelixRequest = typeof HelixRequest.Type;

export const HelixResponse = Schema.Struct({
  status: Schema.Number,
  body: Schema.Json,
  refreshed: Schema.Boolean,
});
export type HelixResponse = typeof HelixResponse.Type;

// ---- EventSub reconciliation ----

export const ReconcileSubscriptionsRequest = Schema.Struct({
  connectionId: Schema.String,
  /**
   * Opaque owner id (for example a project or script id). Each owner's
   * reconcile only removes subscriptions no other owner still wants. Older
   * clients may omit it; the cloud uses `"default"`.
   */
  owner: Schema.optionalKey(Schema.String),
  subscriptions: Schema.Array(TwitchSubscriptionSpec),
});
export type ReconcileSubscriptionsRequest = typeof ReconcileSubscriptionsRequest.Type;

export const ReconcileSubscriptionsResponse = Schema.Struct({
  subscriptions: Schema.Array(TwitchSubscription),
  totalCost: Schema.Number,
  maxCost: Schema.Number,
});
export type ReconcileSubscriptionsResponse = typeof ReconcileSubscriptionsResponse.Type;

// ---- Connections ----

export const ListConnectionsResponse = Schema.Struct({
  connections: Schema.Array(TwitchConnection),
});
export type ListConnectionsResponse = typeof ListConnectionsResponse.Type;

// ---- Errors ----

export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({
    tag: Schema.String,
    message: Schema.String,
    details: Schema.optionalKey(Schema.Json),
  }),
});
export type ApiErrorBody = typeof ApiErrorBody.Type;

export const ErrorTag = Schema.Literals([
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "conflict",
  "missing_scopes",
  "cost_limit_exceeded",
  "rate_limited",
  "upstream_error",
  "internal",
]);
export type ErrorTag = typeof ErrorTag.Type;

export const OAuthCallbackResponse = Schema.Struct({
  userId: Schema.String,
  accountId: Schema.String,
  login: Schema.String,
  displayName: Schema.String,
  pairingCode: Schema.String,
  expiresAt: Schema.Number,
});
export type OAuthCallbackResponse = typeof OAuthCallbackResponse.Type;

/** The JSON body sent when a webhook notification is accepted. */
export const IngressAccepted = Schema.Struct({
  event: EventEnvelope,
});
export type IngressAccepted = typeof IngressAccepted.Type;
