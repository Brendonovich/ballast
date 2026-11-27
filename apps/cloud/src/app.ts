import { EventSub, Protocol } from "@ballast/module-twitch";
import {
  HelixRequest,
  PairingClaimRequest,
  ReconcileSubscriptionsRequest,
  RegisterHooksRequest,
  UnregisterHooksRequest,
  conditionKey,
  subscriptionKey,
  twitchSubscriptionCost,
  type EventEnvelope,
  type PairingClaimResponse,
  type TwitchConnection,
  type TwitchSubscription,
  type WebhookRelayDelivery,
} from "@ballast/cloud-protocol";
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import type { SharesApiRpc } from "@ballast/shares-api";

import { CloudConfig, type CloudConfigService } from "./config.ts";
import { decodeJson, header, html, isJsonRequest, json, redirect, text } from "./http.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import {
  badRequest,
  conflict,
  costLimitExceeded,
  forbidden,
  internalError,
  missingScopes,
  notFound,
  rateLimited,
  unavailable,
  unauthorized,
  upstreamError,
  HttpError,
} from "./errors.ts";
import {
  HOOK_DEFAULT_MAX_AGE_MS,
  HOOK_ID_PATTERN,
  HOOK_MAX_BODY_BYTES,
  HOOK_MAX_MAX_AGE_MS,
  HOOK_MAX_PER_MACHINE,
  HOOK_RATE_WINDOW_MS,
  HOOK_REQUESTS_PER_HOOK,
  HOOK_REQUESTS_PER_IP,
  HOOK_REQUESTS_PER_MACHINE,
  HOOK_REGISTRATIONS_PER_MACHINE,
  HOOK_RETENTION_MS,
  encodeBase64,
  hookResponse,
  hookUrl,
  relayHeaders,
  responseValidationError,
  verificationConfig,
  verificationValidationError,
  verifyHook,
} from "./hooks.ts";
import { RelayGateway, type RelayGatewayService } from "./relay/gateway.ts";
import { makeShareRoutes } from "./shares/routes.ts";
import {
  hashMachineToken,
  randomPairingCode,
  randomToken,
  TokenVault,
  type TokenVaultService,
} from "./secrets.ts";
import {
  CloudStore,
  type CloudStoreService,
  type MachineRow,
  type SubscriptionOwnerRow,
  type SubscriptionRow,
  type TwitchAccountRow,
  type WebhookHookRow,
} from "./store.ts";
import { TwitchApi, type TwitchApiService, type TwitchUser } from "./twitch-api.ts";

export interface CloudAppService {
  readonly fetch: (request: HttpRequest) => Effect.Effect<HttpResponse>;
  /** Used by the /relay route before handing the socket to the Durable Object. */
  readonly authenticateMachine: (request: HttpRequest) => Effect.Effect<MachineRow, HttpError>;
}

export class CloudApp extends Context.Service<CloudApp, CloudAppService>()("Ballast/CloudApp") {}

const pairingCodeTtlMs = 15 * 60_000;
const oauthStateTtlMs = 10 * 60_000;
const accessTokenMarginMs = 60_000;
const machineNameLimit = 100;

/** Pairing claims allowed per client IP in one window. */
export const PAIRING_CLAIM_LIMIT = 10;
/** Pairing codes a user may create in one window (each login creates one). */
export const PAIRING_CODE_CREATE_LIMIT = 5;
/** Both limits use Twitch's 15-minute pairing-code lifetime as their window. */
export const PAIRING_RATE_WINDOW_MS = 15 * 60_000;
/** How long a Worker holds the per-account token-refresh lease. */
export const REFRESH_LOCK_MS = 30_000;
/** How long a second request waits for another Worker's refresh to finish. */
export const REFRESH_WAIT_MS = 2_000;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const bearerToken = (request: HttpRequest): string | undefined => {
  const value = header(request, "authorization");
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
};

const clientIp = (request: HttpRequest): string => {
  const direct = header(request, "cf-connecting-ip");
  if (direct !== undefined && direct.length > 0) return direct.trim();
  const forwarded = header(request, "x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? "unknown" : first;
};

const asJson = (value: unknown): Schema.Json => Schema.decodeUnknownSync(Schema.Json)(value);

const toConnection = (account: TwitchAccountRow): TwitchConnection => ({
  id: account.id,
  twitchUserId: account.twitchUserId,
  login: account.login,
  displayName: account.displayName,
  scopes: [...account.scopes],
  machineId: account.machineId,
  createdAt: account.createdAt,
  needsReauth: account.needsReauth,
});

const toSubscription = (
  row: SubscriptionRow,
  owners?: ReadonlyArray<string>,
): TwitchSubscription => ({
  id: row.id,
  providerSubscriptionId: row.providerSubscriptionId,
  type: row.type,
  version: row.version,
  condition: row.condition,
  status: row.status,
  cost: row.cost,
  ...(owners === undefined ? {} : { owners: [...owners] }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const sameKey = (
  row: SubscriptionRow,
  spec: {
    readonly type: string;
    readonly version: number;
    readonly condition: Readonly<Record<string, string>>;
  },
) =>
  row.type === spec.type &&
  row.version === spec.version &&
  conditionKey(row.condition) === conditionKey(spec.condition);

/**
 * Validate a condition against Twitch's authorization rules for a known
 * subscription type. `self` fields must be the token's own user; `target`
 * fields may be another linked account, or any channel where Twitch allows
 * the token to read/moderate. Unknown types keep the old strict rule.
 *
 * Returns an error message, or undefined when the condition is valid.
 */
const conditionError = (
  type: string,
  condition: Readonly<Record<string, string>>,
  connectionTwitchUserId: string,
  linkedTwitchUserIds: ReadonlySet<string>,
): string | undefined => {
  if (!EventSub.isSubscriptionType(type)) {
    if (Object.keys(condition).length === 0)
      return "Every EventSub condition value must be the connection's Twitch user id";
    const mismatch = Object.values(condition).find(
      (value) => value !== connectionTwitchUserId,
    );
    return mismatch === undefined
      ? undefined
      : "Every EventSub condition value must be the connection's Twitch user id";
  }
  const definition = EventSub.subscriptions[type];
  for (const [field, value] of Object.entries(condition)) {
    const role = definition.conditionRoles[field];
    if (role === undefined)
      return `Condition field ${field} is not used by ${type}`;
    if (role === "self" && value !== connectionTwitchUserId)
      return `${field} must be the connection's own Twitch user id`;
    if (
      role === "target" &&
      !linkedTwitchUserIds.has(value) &&
      definition.targetPolicy !== "linked-or-any"
    )
      return `${field} must be a linked Twitch account`;
  }
  return undefined;
};

const effectivePolicy = (
  owners: ReadonlyArray<Pick<SubscriptionOwnerRow, "onStale" | "maxAgeMs">>,
): { readonly onStale: "drop" | "deliver"; readonly maxAgeMs: number } => {
  if (owners.length === 0) return { onStale: "drop", maxAgeMs: 60_000 };
  return {
    // Dropping is the conservative choice: one client asking for fresh-only
    // events must not make stale events appear for everyone sharing the row.
    onStale: owners.some((owner) => owner.onStale === "drop") ? "drop" : "deliver",
    maxAgeMs: Math.min(...owners.map((owner) => owner.maxAgeMs)),
  };
};

const subscriptionCost = (type: string): number =>
  EventSub.isSubscriptionType(type)
    ? EventSub.subscriptions[type].cost
    : twitchSubscriptionCost(type);

const errorBody = (error: HttpError): unknown => ({
  error: {
    tag: error.tag,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});

const errorResponse = (error: HttpError): HttpResponse =>
  json(error.status, errorBody(error), error.headers);

/**
 * EventSub revocations we can recover from without the user reconnecting.
 * Every other reason (authorization/user removal, version removal, limits)
 * needs a person or a manifest change.
 */
const recoverableRevocation = (reason: string): boolean =>
  reason === "notification_failures_exceeded";

export interface CloudAppDeps {
  readonly config: CloudConfigService;
  readonly store: CloudStoreService;
  readonly vault: TokenVaultService;
  readonly twitch: TwitchApiService;
  readonly relay: RelayGatewayService;
  /**
   * The shares API Worker (`@ballast/shares-api`) for project sharing
   * (decision 0013); omitted, the share routes 404.
   */
  readonly shares?: SharesApiRpc;
}

export const makeCloudApp = (
  deps: CloudAppDeps,
): Effect.Effect<CloudAppService> =>
  Effect.gen(function* () {
    const { config, store, vault, twitch, relay } = deps;

    let appToken: { readonly token: string; readonly expiresAt: number } | undefined;

    const openSecret = (sealed: Parameters<typeof vault.open>[0]) =>
      vault
        .open(sealed)
        .pipe(Effect.mapError(() => internalError("A stored secret could not be decrypted")));

    const sealSecret = (value: string) =>
      vault
        .seal(value)
        .pipe(Effect.mapError(() => internalError("A secret could not be encrypted")));

    const authenticateMachine = (request: HttpRequest): Effect.Effect<MachineRow, HttpError> =>
      Effect.gen(function* () {
        const token = bearerToken(request);
        if (token === undefined) return yield* unauthorized();
        const hash = yield* Effect.promise(() => hashMachineToken(config.tokenPepper, token));
        const machine = yield* store.findMachineByTokenHash(hash);
        if (Option.isNone(machine)) return yield* unauthorized();
        const now = yield* Clock.currentTimeMillis;
        yield* store.touchMachine(machine.value.id, now);
        return machine.value;
      });

    const accountFor = (machine: MachineRow, connectionId: string) =>
      Effect.gen(function* () {
        const account = yield* store.findAccount(connectionId);
        if (Option.isNone(account)) return yield* notFound("Unknown Twitch connection");
        if (account.value.userId !== machine.userId)
          return yield* forbidden("That Twitch connection belongs to another user");
        return account.value;
      });

    const enforceRateLimit = (
      bucket: string,
      limit: number,
      windowMs: number,
      now: number,
    ): Effect.Effect<void, HttpError> =>
      Effect.gen(function* () {
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const count = yield* store.incrementRateLimit({
          key: bucket,
          windowStart,
          expiresAt: windowStart + windowMs,
        });
        yield* store.pruneRateLimits(now);
        if (count > limit)
          return yield* rateLimited(
            "Too many attempts; try again later",
            { limit, windowMs },
            Math.ceil(windowMs / 1_000),
          );
      });

    const shares =
      deps.shares === undefined
        ? undefined
        : makeShareRoutes({ api: deps.shares, relay, enforceRateLimit });

    const needsFreshToken = (account: TwitchAccountRow, force: boolean): boolean =>
      force ||
      account.secrets.accessToken === null ||
      account.secrets.accessTokenExpiresAt - accessTokenMarginMs <= Date.now();

    const refreshedAccount = (
      account: TwitchAccountRow,
      accessToken: string,
      tokens: { readonly accessToken: string; readonly refreshToken: string | null; readonly expiresAt: number; readonly scopes: ReadonlyArray<string> },
      secrets: TwitchAccountRow["secrets"],
      refreshed: boolean,
    ) => ({
      accessToken,
      account: {
        ...account,
        secrets,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : account.scopes,
        needsReauth: false,
        refreshLock: null,
        refreshLockUntil: 0,
      },
      refreshed,
    });

    /**
     * Get a usable access token, refreshing under a D1 lease so two Workers
     * cannot race Twitch's rotating refresh token. A second request waits
     * briefly for the holder, then reports a retryable upstream error.
     */
    const accessTokenFor = (account: TwitchAccountRow, force: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!needsFreshToken(account, force) && account.secrets.accessToken !== null) {
          return {
            accessToken: yield* openSecret(account.secrets.accessToken),
            account,
            refreshed: false,
          };
        }

        const lockToken = crypto.randomUUID();
        const acquired = yield* store.tryAcquireRefreshLock(
          account.id,
          lockToken,
          now,
          now + REFRESH_LOCK_MS,
        );

        if (!acquired) {
          const deadline = now + REFRESH_WAIT_MS;
          let current = yield* store.findAccount(account.id);
          while (Option.isSome(current) && Date.now() < deadline) {
            const candidate = current.value;
            const stillLocked =
              candidate.refreshLock !== null && candidate.refreshLockUntil > Date.now();
            const fresh =
              candidate.secrets.accessToken !== null &&
              candidate.secrets.accessTokenExpiresAt - accessTokenMarginMs > Date.now();
            const changed =
              candidate.secrets.accessToken !== null &&
              candidate.secrets.accessToken.ciphertext !==
                account.secrets.accessToken?.ciphertext;
            if (
              !stillLocked &&
              fresh &&
              (!force || changed) &&
              candidate.secrets.accessToken !== null
            ) {
              return {
                accessToken: yield* openSecret(candidate.secrets.accessToken),
                account: candidate,
                refreshed: false,
              };
            }
            if (!stillLocked) break;
            yield* Effect.sleep(Duration.millis(50));
            current = yield* store.findAccount(account.id);
          }
          return yield* upstreamError(
            "Another request is refreshing this connection's token; retry shortly",
            { retryable: true },
          );
        }

        return yield* Effect.gen(function* () {
          const current = yield* store.findAccount(account.id);
          if (Option.isNone(current)) return yield* notFound("Unknown Twitch connection");
          if (
            !needsFreshToken(current.value, force) &&
            current.value.secrets.accessToken !== null
          ) {
            const accessToken = yield* openSecret(current.value.secrets.accessToken);
            return { accessToken, account: current.value, refreshed: false };
          }

          const refreshToken = yield* openSecret(current.value.secrets.refreshToken);
          const tokens = yield* twitch.refresh(refreshToken).pipe(
            Effect.mapError((error) =>
              upstreamError("Twitch rejected the stored refresh token", {
                status: error.status,
                body: error.body,
              }),
            ),
          );
          const access = yield* sealSecret(tokens.accessToken);
          const refresh =
            tokens.refreshToken === null
              ? current.value.secrets.refreshToken
              : yield* sealSecret(tokens.refreshToken);
          const secrets = {
            ...current.value.secrets,
            refreshToken: refresh,
            accessToken: access,
            accessTokenExpiresAt: tokens.expiresAt,
          };
          const updatedAt = yield* Clock.currentTimeMillis;
          const committed = yield* store.updateAccountSecrets(
            current.value.id,
            secrets,
            updatedAt,
            lockToken,
          );
          if (!committed) {
            const winner = yield* store.findAccount(current.value.id);
            if (Option.isSome(winner) && winner.value.secrets.accessToken !== null) {
              return {
                accessToken: yield* openSecret(winner.value.secrets.accessToken),
                account: winner.value,
                refreshed: true,
              };
            }
            return yield* upstreamError("The token refresh lease was lost; retry", {
              retryable: true,
            });
          }
          yield* store.setAccountNeedsReauth(current.value.id, false, updatedAt);
          return refreshedAccount(
            current.value,
            tokens.accessToken,
            tokens,
            secrets,
            true,
          );
        }).pipe(
          Effect.ensuring(
            store.releaseRefreshLock(account.id, lockToken).pipe(Effect.orDie),
          ),
        );
      });

    const appAccessToken = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (appToken !== undefined && appToken.expiresAt - accessTokenMarginMs > now)
        return appToken.token;
      const tokens = yield* twitch
        .clientCredentials.pipe(
          Effect.mapError((error) =>
            upstreamError("Could not obtain a Twitch app access token", { status: error.status }),
          ),
        );
      appToken = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      return tokens.accessToken;
    });

    const reconcileSubscriptions = (
      machine: MachineRow,
      request: ReconcileSubscriptionsRequest,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const account = yield* accountFor(machine, request.connectionId);
        const now = yield* Clock.currentTimeMillis;
        const owner = (request.owner ?? "default").trim().slice(0, 200) || "default";
        const linkedAccounts = yield* store.listAccountsByUser(machine.userId);
        const linkedIds = new Set(linkedAccounts.map((linked) => linked.twitchUserId));
        const desired = new Map<string, ReconcileSubscriptionsRequest["subscriptions"][number]>();
        for (const spec of request.subscriptions) {
          if (spec.type.length === 0 || spec.version < 1 || spec.maxAgeMs < 0)
            return yield* badRequest("Invalid EventSub subscription spec", { spec });
          const invalid = conditionError(
            spec.type,
            spec.condition,
            account.twitchUserId,
            linkedIds,
          );
          if (invalid !== undefined)
            return yield* badRequest(invalid, {
              type: spec.type,
              condition: spec.condition,
              connectionUserId: account.twitchUserId,
            });
          if (EventSub.isSubscriptionType(spec.type)) {
            const definition = EventSub.subscriptions[spec.type];
            const condition = yield* Schema.decodeUnknownEffect(definition.condition)(
              spec.condition,
            ).pipe(
              Effect.mapError(() =>
                badRequest(`Invalid condition for ${spec.type}`, {
                  condition: spec.condition,
                }),
              ),
            );
            const missing = definition.scopes.filter(
              (scope) => !account.scopes.includes(scope),
            );
            if (missing.length > 0)
              return yield* missingScopes(
                `The connection has not granted the scopes ${spec.type} needs`,
                { missing, type: spec.type, condition },
              );
          }
          const key = subscriptionKey(spec);
          if (desired.has(key))
            return yield* badRequest("Duplicate EventSub subscription", { key });
          desired.set(key, spec);
        }

        const previousRows = yield* store.listSubscriptions(account.id);
        const previousOwners = yield* store.listSubscriptionOwners(account.id);
        const previousOwnersBySubscription = new Map<string, Array<SubscriptionOwnerRow>>();
        for (const link of previousOwners) {
          const list = previousOwnersBySubscription.get(link.subscriptionId) ?? [];
          list.push(link);
          previousOwnersBySubscription.set(link.subscriptionId, list);
        }

        // The union this reconcile will leave behind: every spec another owner
        // still wants, plus this owner's desired specs.
        const prospective = new Map<
          string,
          {
            readonly type: string;
            readonly version: number;
            readonly condition: Readonly<Record<string, string>>;
            readonly onStale: "drop" | "deliver";
            readonly maxAgeMs: number;
          }
        >();
        for (const row of previousRows) {
          const owners = previousOwnersBySubscription.get(row.id) ?? [];
          if (owners.some((link) => link.owner !== owner))
            prospective.set(subscriptionKey(row), row);
        }
        for (const [key, spec] of desired) prospective.set(key, spec);

        const totalCost = [...prospective.values()].reduce(
          (total, spec) => total + subscriptionCost(spec.type),
          0,
        );
        if (totalCost > config.maxSubscriptionCost)
          return yield* costLimitExceeded(
            `This connection would use ${totalCost} of Twitch's ${config.maxSubscriptionCost} EventSub cost budget`,
            { totalCost, maxCost: config.maxSubscriptionCost },
          );

        yield* store.updateAccountMachine(account.id, machine.id, now);

        const appTokenValue = yield* appAccessToken;
        const callbackUrl = `${config.publicOrigin}/webhooks/twitch/eventsub/${account.id}`;
        const providerSubscriptions = yield* twitch
          .listEventSubSubscriptions(appTokenValue)
          .pipe(
            Effect.mapError((error) =>
              upstreamError("Could not list Twitch EventSub subscriptions", {
                status: error.status,
                body: error.body,
              }),
            ),
          );

        const ours = providerSubscriptions.filter(
          (subscription) =>
            subscription.transport.method === "webhook" &&
            subscription.transport.callback === callbackUrl,
        );

        // Remove provider subscriptions no owner wants any more.
        for (const subscription of ours) {
          const key = subscriptionKey({
            type: subscription.type,
            version: Number(subscription.version),
            condition: subscription.condition,
          });
          if (prospective.has(key)) continue;
          yield* twitch.deleteEventSubSubscription(appTokenValue, subscription.id).pipe(
            Effect.catchTag("TwitchError", (error) =>
              error.status === 404
                ? Effect.void
                : Effect.fail(
                    upstreamError("Could not delete a Twitch EventSub subscription", {
                      status: error.status,
                      body: error.body,
                    }),
                  ),
            ),
          );
        }

        const webhookSecret = yield* openSecret(account.secrets.webhookSecret);
        const rowsByKey = new Map<string, SubscriptionRow>();

        for (const [key, spec] of prospective) {
          const previous = previousRows.find((row) => sameKey(row, spec));
          const provider = ours.find(
            (candidate) =>
              subscriptionKey({
                type: candidate.type,
                version: Number(candidate.version),
                condition: candidate.condition,
              }) === key,
          );
          const otherPolicies = (
            previous === undefined
              ? []
              : previousOwnersBySubscription.get(previous.id) ?? []
          ).filter((link) => link.owner !== owner);
          const effective = effectivePolicy([
            ...otherPolicies,
            { onStale: spec.onStale, maxAgeMs: spec.maxAgeMs },
          ]);
          const base: SubscriptionRow = {
            id: previous?.id ?? crypto.randomUUID(),
            accountId: account.id,
            machineId: machine.id,
            type: spec.type,
            version: spec.version,
            condition: spec.condition,
            cost: subscriptionCost(spec.type),
            providerSubscriptionId: provider?.id ?? previous?.providerSubscriptionId ?? null,
            status: provider === undefined ? "pending" : "enabled",
            onStale: effective.onStale,
            maxAgeMs: effective.maxAgeMs,
            lastError: null,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };

          if (provider !== undefined) {
            yield* store.upsertSubscription(base);
            rowsByKey.set(key, base);
            continue;
          }

          const created = yield* twitch
            .createEventSubSubscription(appTokenValue, {
              type: spec.type,
              version: spec.version,
              condition: spec.condition,
              callback: callbackUrl,
              secret: webhookSecret,
            })
            .pipe(
              Effect.mapError((error) =>
                upstreamError("Twitch rejected an EventSub subscription", {
                  type: spec.type,
                  status: error.status,
                  body: error.body,
                }),
              ),
            );
          const row: SubscriptionRow = {
            ...base,
            providerSubscriptionId: created.id,
            status: "enabled",
            updatedAt: now,
          };
          yield* store.upsertSubscription(row);
          rowsByKey.set(key, row);
        }

        // Record this owner's links, then drop links for specs it no longer wants.
        for (const [key, spec] of desired) {
          const row = rowsByKey.get(key);
          if (row === undefined)
            return yield* internalError("The reconciled subscription row is missing");
          const existing = previousOwners.find(
            (link) => link.subscriptionId === row.id && link.owner === owner,
          );
          yield* store.upsertSubscriptionOwner({
            subscriptionId: row.id,
            owner,
            onStale: spec.onStale,
            maxAgeMs: spec.maxAgeMs,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        }
        for (const link of previousOwners) {
          if (link.owner !== owner) continue;
          const row = previousRows.find((candidate) => candidate.id === link.subscriptionId);
          if (row !== undefined && desired.has(subscriptionKey(row))) continue;
          yield* store.deleteSubscriptionOwner(link.subscriptionId, owner);
        }

        // Recompute shared freshness from the final owner set and delete rows
        // that nobody owns any more.
        const finalOwners = yield* store.listSubscriptionOwners(account.id);
        const finalOwnersBySubscription = new Map<string, Array<SubscriptionOwnerRow>>();
        for (const link of finalOwners) {
          const list = finalOwnersBySubscription.get(link.subscriptionId) ?? [];
          list.push(link);
          finalOwnersBySubscription.set(link.subscriptionId, list);
        }
        const responseRows: Array<SubscriptionRow> = [];
        for (const row of yield* store.listSubscriptions(account.id)) {
          const owners = finalOwnersBySubscription.get(row.id) ?? [];
          if (owners.length === 0) {
            yield* store.deleteSubscription(row.id);
            continue;
          }
          const effective = effectivePolicy(owners);
          const updated: SubscriptionRow = {
            ...row,
            machineId: machine.id,
            onStale: effective.onStale,
            maxAgeMs: effective.maxAgeMs,
            updatedAt: now,
          };
          if (
            row.machineId !== updated.machineId ||
            row.onStale !== updated.onStale ||
            row.maxAgeMs !== updated.maxAgeMs
          )
            yield* store.upsertSubscription(updated);
          responseRows.push(updated);
        }

        return json(200, {
          subscriptions: responseRows.map((row) =>
            toSubscription(
              row,
              (finalOwnersBySubscription.get(row.id) ?? []).map((link) => link.owner),
            ),
          ),
          totalCost,
          maxCost: config.maxSubscriptionCost,
        });
      });

    const handleOAuthStart = (url: URL): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const requested = (url.searchParams.get("scopes") ?? "")
          .split(/[,\s]+/)
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0);
        const scopes = [...new Set(requested.length > 0 ? requested : config.defaultScopes)];
        if (scopes.length > 32 || scopes.some((scope) => !/^[a-z][a-z0-9:_-]*$/i.test(scope)))
          return yield* badRequest("Invalid Twitch scopes");
        const state = randomToken(24);
        const now = yield* Clock.currentTimeMillis;
        const redirectUri = `${config.publicOrigin}/oauth/twitch/callback`;
        yield* store.insertOAuthState({
          state,
          scopes,
          redirectUri,
          createdAt: now,
          expiresAt: now + oauthStateTtlMs,
        });
        return redirect(
          twitch.authorizeUrl({
            redirectUri,
            scopes,
            state,
            forceVerify: true,
          }),
        );
      });

    const handleOAuthCallback = (
      request: HttpRequest,
      url: URL,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const error = url.searchParams.get("error");
        if (error !== null)
          return yield* badRequest(
            url.searchParams.get("error_description") ?? `Twitch authorization failed: ${error}`,
          );
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (state === null || code === null) return yield* badRequest("Missing OAuth state or code");
        const now = yield* Clock.currentTimeMillis;
        const stored = yield* store.takeOAuthState(state, now);
        if (Option.isNone(stored))
          return yield* badRequest("OAuth state is invalid or expired; start again");

        const tokens = yield* twitch
          .exchangeAuthorizationCode(code, stored.value.redirectUri)
          .pipe(
            Effect.mapError((failure) =>
              upstreamError("Twitch rejected the authorization code", {
                status: failure.status,
                body: failure.body,
              }),
            ),
          );
        if (tokens.refreshToken === null)
          return yield* upstreamError("Twitch did not return a refresh token");

        const twitchUser: TwitchUser = yield* twitch.getUser(tokens.accessToken).pipe(
          Effect.mapError((failure) =>
            upstreamError("Could not read the Twitch user", { status: failure.status }),
          ),
        );
        const userId = twitchUser.id;
        yield* store.upsertUser({
          id: userId,
          login: twitchUser.login,
          displayName: twitchUser.displayName,
          email: twitchUser.email,
          createdAt: now,
          updatedAt: now,
        });

        yield* enforceRateLimit(
          `pairing-create:${userId}`,
          PAIRING_CODE_CREATE_LIMIT,
          PAIRING_RATE_WINDOW_MS,
          now,
        );

        const existing = yield* store.findAccountByTwitchUser(userId, twitchUser.id);
        const accountId = Option.isSome(existing) ? existing.value.id : crypto.randomUUID();
        const webhookSecret = Option.isSome(existing)
          ? existing.value.secrets.webhookSecret
          : yield* sealSecret(randomToken(32));
        const secrets = {
          refreshToken: yield* sealSecret(tokens.refreshToken),
          accessToken: yield* sealSecret(tokens.accessToken),
          accessTokenExpiresAt: tokens.expiresAt,
          webhookSecret,
        };
        const account: TwitchAccountRow = {
          id: accountId,
          userId,
          twitchUserId: twitchUser.id,
          login: twitchUser.login,
          displayName: twitchUser.displayName,
          scopes: tokens.scopes.length > 0 ? tokens.scopes : stored.value.scopes,
          secrets,
          machineId: Option.isSome(existing) ? existing.value.machineId : null,
          needsReauth: false,
          refreshLock: null,
          refreshLockUntil: 0,
          createdAt: Option.isSome(existing) ? existing.value.createdAt : now,
          updatedAt: now,
        };
        yield* store.upsertTwitchAccount(account);

        const pairingCode = randomPairingCode();
        const expiresAt = now + pairingCodeTtlMs;
        yield* store.insertPairingCode({ code: pairingCode, userId, createdAt: now, expiresAt });

        if (isJsonRequest(request, url))
          return json(200, {
            userId,
            accountId,
            login: twitchUser.login,
            displayName: twitchUser.displayName,
            pairingCode,
            expiresAt,
          });

        return html(
          200,
          `<!doctype html><html><head><meta charset="utf-8"><title>Ballast</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; line-height: 1.5">
<h1>Twitch connected</h1>
<p>Signed in as <strong>${escapeHtml(twitchUser.displayName)}</strong> (${escapeHtml(twitchUser.login)}).</p>
<p>Re-authorized the account already linked to your machine? Return to Ballast and choose <strong>Check again</strong>; no pairing code is needed.</p>
<p>Pairing a machine for the first time? Enter this code under <strong>Settings → Cloud</strong> in Ballast:</p>
<p style="font-size: 2rem; letter-spacing: 0.2em; font-weight: 700">${escapeHtml(pairingCode)}</p>
<p>The code expires in 15 minutes.</p>
</body></html>`,
        );
      });

    const handlePairingClaim = (request: HttpRequest): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* enforceRateLimit(
          `pairing-claim:${clientIp(request)}`,
          PAIRING_CLAIM_LIMIT,
          PAIRING_RATE_WINDOW_MS,
          now,
        );
        const body = yield* decodeJson(PairingClaimRequest, request.body);
        const code = body.code.trim().toUpperCase();
        const pairing = yield* store.takePairingCode(code, now);
        if (Option.isNone(pairing))
          return yield* notFound("Pairing code is invalid or has expired");
        const user = yield* store.findUser(pairing.value.userId);
        if (Option.isNone(user)) return yield* conflict("The pairing code's user no longer exists");
        const machineId = `m_${randomToken(18)}`;
        const machineToken = `blst_m_${randomToken(32)}`;
        const tokenHash = yield* Effect.promise(() =>
          hashMachineToken(config.tokenPepper, machineToken),
        );
        const name = body.machineName.trim().slice(0, machineNameLimit) || "Ballast machine";
        yield* store.insertMachine({
          id: machineId,
          userId: pairing.value.userId,
          name,
          tokenHash,
          createdAt: now,
          lastSeenAt: now,
        });
        return json(200, {
          machineId,
          machineToken,
          user: {
            id: user.value.id,
            login: user.value.login,
            displayName: user.value.displayName,
          },
        } satisfies PairingClaimResponse);
      });

    const handleListConnections = (
      machine: MachineRow,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const accounts = yield* store.listAccountsByUser(machine.userId);
        return json(200, { connections: accounts.map(toConnection) });
      });

    const handleRegisterHooks = (
      machine: MachineRow,
      request: HttpRequest,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* enforceRateLimit(
          `hooks-register:${machine.id}`,
          HOOK_REGISTRATIONS_PER_MACHINE,
          HOOK_RATE_WINDOW_MS,
          now,
        );
        const body = yield* decodeJson(RegisterHooksRequest, request.body);
        if (body.hooks.length > HOOK_MAX_PER_MACHINE)
          return yield* badRequest(
            `A machine may register at most ${HOOK_MAX_PER_MACHINE} hooks`,
          );
        const existing = yield* store.listHooks(machine.id);
        const existingByHookId = new Map(existing.map((hook) => [hook.hookId, hook]));
        const seen = new Set<string>();
        const rows: Array<WebhookHookRow> = [];
        for (const registration of body.hooks) {
          if (!HOOK_ID_PATTERN.test(registration.hookId))
            return yield* badRequest(
              "hookId must be 22-64 base64url characters",
              { hookId: registration.hookId },
            );
          if (seen.has(registration.hookId))
            return yield* badRequest("Duplicate hookId", { hookId: registration.hookId });
          seen.add(registration.hookId);

          const maxAgeMs = registration.maxAgeMs ?? HOOK_DEFAULT_MAX_AGE_MS;
          if (
            !Number.isInteger(maxAgeMs) ||
            maxAgeMs < 0 ||
            maxAgeMs > HOOK_MAX_MAX_AGE_MS
          )
            return yield* badRequest("maxAgeMs must be an integer from 0 to 86400000");
          const onStale = registration.onStale ?? "drop";
          const verificationError = verificationValidationError(registration.verification);
          if (verificationError !== undefined)
            return yield* badRequest(verificationError, {
              hookId: registration.hookId,
            });
          const responseError = responseValidationError(registration.response);
          if (responseError !== undefined)
            return yield* badRequest(responseError, { hookId: registration.hookId });

          const verification =
            registration.verification === undefined
              ? null
              : verificationConfig(registration.verification);
          const secret =
            registration.verification === undefined
              ? null
              : yield* sealSecret(registration.verification.secret);
          rows.push({
            id: crypto.randomUUID(),
            machineId: machine.id,
            hookId: registration.hookId,
            label: registration.label ?? null,
            verification,
            secret,
            response: registration.response ?? null,
            maxAgeMs,
            onStale,
            createdAt: existingByHookId.get(registration.hookId)?.createdAt ?? now,
            updatedAt: now,
          });
        }
        yield* store.replaceHooks(machine.id, rows);
        yield* store.pruneHooks(now - HOOK_RETENTION_MS);
        return json(200, {
          hooks: rows.map((row) => ({
            hookId: row.hookId,
            url: hookUrl(config.publicOrigin, machine.id, row.hookId),
          })),
        });
      });

    const handleUnregisterHooks = (
      machine: MachineRow,
      request: HttpRequest,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* enforceRateLimit(
          `hooks-register:${machine.id}`,
          HOOK_REGISTRATIONS_PER_MACHINE,
          HOOK_RATE_WINDOW_MS,
          now,
        );
        const body = yield* decodeJson(UnregisterHooksRequest, request.body);
        yield* store.deleteHooks(machine.id, body.hookIds);
        return { status: 204 };
      });

    const handleListHooks = (
      machine: MachineRow,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const hooks = yield* store.listHooks(machine.id);
        return json(200, {
          hooks: hooks.map((hook) => ({
            hookId: hook.hookId,
            url: hookUrl(config.publicOrigin, machine.id, hook.hookId),
            label: hook.label,
            maxAgeMs: hook.maxAgeMs,
            onStale: hook.onStale,
          })),
        });
      });

    const handlePublicHook = (
      request: HttpRequest,
      machineId: string,
      hookId: string,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        if (machineId.length === 0 || !HOOK_ID_PATTERN.test(hookId))
          return yield* notFound("Not found");
        const found = yield* store.findHook(machineId, hookId);
        if (Option.isNone(found)) return yield* notFound("Not found");
        const hook = found.value;
        const now = yield* Clock.currentTimeMillis;
        const ip = clientIp(request);
        yield* enforceRateLimit(
          `hook:${machineId}:${hookId}`,
          HOOK_REQUESTS_PER_HOOK,
          HOOK_RATE_WINDOW_MS,
          now,
        );
        yield* enforceRateLimit(
          `machine-hooks:${machineId}`,
          HOOK_REQUESTS_PER_MACHINE,
          HOOK_RATE_WINDOW_MS,
          now,
        );
        yield* enforceRateLimit(
          `hook-ip:${ip}`,
          HOOK_REQUESTS_PER_IP,
          HOOK_RATE_WINDOW_MS,
          now,
        );

        const declaredLength = Number(header(request, "content-length"));
        if (
          request.body.byteLength > HOOK_MAX_BODY_BYTES ||
          (Number.isFinite(declaredLength) && declaredLength > HOOK_MAX_BODY_BYTES)
        )
          return text(413, "Payload Too Large");

        if (hook.verification !== null) {
          if (hook.secret === null) return { status: 401 };
          const secret = yield* openSecret(hook.secret);
          const verified = yield* verifyHook({
            verification: hook.verification,
            secret,
            headers: request.headers,
            body: request.body,
            now,
          });
          if (!verified) return { status: 401 };
        }

        const url = new URL(request.url);
        const delivery: WebhookRelayDelivery = {
          hookId: hook.hookId,
          deliveryId: crypto.randomUUID(),
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: relayHeaders(request.headers),
          bodyBase64: encodeBase64(request.body),
          receivedAt: now,
        };
        yield* relay
          .enqueueWebhook(machineId, delivery, {
            maxAgeMs: hook.maxAgeMs,
            onStale: hook.onStale,
          })
          .pipe(
            Effect.mapError(() =>
              unavailable("The webhook relay is unavailable; retry shortly"),
            ),
            Effect.catchCause(() =>
              Effect.fail(unavailable("The webhook relay is unavailable; retry shortly")),
            ),
          );
        return hookResponse(hook.response, request.method);
      });

    const handleGetToken = (
      machine: MachineRow,
      request: HttpRequest,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const body = yield* decodeJson(
          Schema.Struct({ connectionId: Schema.String }),
          request.body,
        );
        const account = yield* accountFor(machine, body.connectionId);
        const token = yield* accessTokenFor(account, false);
        return json(200, {
          accessToken: token.accessToken,
          expiresAt: token.account.secrets.accessTokenExpiresAt,
          scopes: token.account.scopes,
          twitchUserId: token.account.twitchUserId,
          login: token.account.login,
        });
      });

    const handleHelix = (
      machine: MachineRow,
      request: HttpRequest,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const body = yield* decodeJson(HelixRequest, request.body);
        const account = yield* accountFor(machine, body.connectionId);
        if (!body.path.startsWith("/helix/") || body.path.startsWith("/helix//"))
          return yield* badRequest("Helix paths must start with /helix/");
        const missing = body.scopes.filter((scope) => !account.scopes.includes(scope));
        if (missing.length > 0)
          return yield* missingScopes("The connection has not granted every requested scope", {
            missing,
          });

        const call = (accessToken: string) =>
          twitch.helix({
            accessToken,
            method: body.method,
            path: body.path,
            ...(body.query === undefined ? {} : { query: body.query }),
            ...(body.body === undefined ? {} : { body: body.body }),
          });

        const first = yield* accessTokenFor(account, false);
        let response = yield* call(first.accessToken).pipe(
          Effect.mapError((failure) =>
            upstreamError("Twitch Helix request failed", {
              status: failure.status,
              body: failure.body,
            }),
          ),
        );
        let refreshed = first.refreshed;
        if (response.status === 401) {
          const retry = yield* accessTokenFor(first.account, true);
          refreshed = true;
          response = yield* call(retry.accessToken).pipe(
            Effect.mapError((failure) =>
              upstreamError("Twitch Helix request failed", {
                status: failure.status,
                body: failure.body,
              }),
            ),
          );
        }
        return json(200, {
          status: response.status,
          body: asJson(response.body),
          refreshed,
        });
      });

    const notifyRevoked = (
      machineId: string,
      connectionId: string,
      type: string,
      providerSubscriptionId: string,
      revokedAt: number,
    ): Effect.Effect<void, HttpError> =>
      relay
        .notify(machineId, {
          _tag: "subscription_revoked",
          connectionId,
          subscriptionType: type,
          providerSubscriptionId,
          revokedAt,
        })
        .pipe(Effect.mapError(() => internalError("The relay could not be notified")));

    const handleRevocation = (
      account: TwitchAccountRow,
      subscription: EventSub.EventSubSubscription,
      now: number,
    ): Effect.Effect<void, HttpError> =>
      Effect.gen(function* () {
        const row = yield* store.findSubscriptionByProviderId(subscription.id);
        if (Option.isNone(row)) {
          yield* store.markSubscriptionRevoked(subscription.id, now, subscription.status);
          return;
        }
        const stored = row.value;
        const reason = subscription.status;

        if (recoverableRevocation(reason)) {
          const recovered = yield* Effect.gen(function* () {
            const appTokenValue = yield* appAccessToken;
            yield* twitch.deleteEventSubSubscription(appTokenValue, subscription.id).pipe(
              Effect.catchTag("TwitchError", (failure) =>
                failure.status === 404 ? Effect.void : Effect.fail(failure),
              ),
            );
            const webhookSecret = yield* openSecret(account.secrets.webhookSecret);
            return yield* twitch.createEventSubSubscription(appTokenValue, {
              type: stored.type,
              version: stored.version,
              condition: stored.condition,
              callback: `${config.publicOrigin}/webhooks/twitch/eventsub/${account.id}`,
              secret: webhookSecret,
            });
          }).pipe(Effect.result);

          if (recovered._tag === "Success") {
            yield* store.upsertSubscription({
              ...stored,
              providerSubscriptionId: recovered.success.id,
              status: "enabled",
              lastError: null,
              updatedAt: now,
            });
            return;
          }
          yield* store.markSubscriptionRevoked(
            subscription.id,
            now,
            `${reason}: ${recovered.failure.message}`,
          );
        } else {
          yield* store.markSubscriptionRevoked(subscription.id, now, reason);
          if (reason === "authorization_revoked" || reason === "user_removed")
            yield* store.setAccountNeedsReauth(account.id, true, now);
        }

        yield* notifyRevoked(
          stored.machineId,
          account.id,
          stored.type,
          subscription.id,
          now,
        );
      });

    const handleWebhook = (
      request: HttpRequest,
      accountId: string,
    ): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const account = yield* store.findAccount(accountId);
        if (Option.isNone(account)) return yield* notFound("Unknown EventSub endpoint");
        const messageType = header(request, EventSub.MESSAGE_TYPE_HEADER);
        if (messageType === undefined)
          return yield* badRequest("Missing Twitch EventSub headers");
        const now = yield* Clock.currentTimeMillis;
        const webhookSecret = yield* openSecret(account.value.secrets.webhookSecret);

        const delivery = yield* EventSub.decodeWebhook({
          headers: request.headers,
          body: request.body,
          secret: webhookSecret,
          now,
          toleranceMs: config.webhookTimestampToleranceMs,
        }).pipe(
          Effect.mapError((failure) =>
            failure._tag === "WebhookVerificationError"
              ? failure.code === "missing-header" ||
                failure.code === "invalid-timestamp" ||
                failure.code === "crypto-unavailable"
                ? badRequest(failure.message)
                : forbidden(failure.message)
              : badRequest("Invalid EventSub delivery"),
          ),
        );

        const definition = EventSub.isSubscriptionType(delivery.subscription.type)
          ? EventSub.subscriptions[delivery.subscription.type]
          : undefined;
        const needsLinkedAccounts =
          definition !== undefined &&
          Object.values(definition.conditionRoles).some((role) => role === "target") &&
          definition.targetPolicy !== "linked-or-any";
        const linkedIds = needsLinkedAccounts
          ? new Set(
              (yield* store.listAccountsByUser(account.value.userId)).map(
                (linked) => linked.twitchUserId,
              ),
            )
          : new Set<string>();
        const invalid = conditionError(
          delivery.subscription.type,
          delivery.subscription.condition,
          account.value.twitchUserId,
          linkedIds,
        );
        if (invalid !== undefined) return yield* badRequest(invalid);

        if (delivery._tag === "verification") {
          if (messageType !== "webhook_callback_verification")
            return yield* badRequest("EventSub message type does not match its body");
          return text(200, delivery.challenge);
        }

        if (delivery._tag === "revocation") {
          if (messageType !== "revocation")
            return yield* badRequest("EventSub message type does not match its body");
          yield* handleRevocation(account.value, delivery.subscription, now);
          return { status: 204 };
        }

        if (messageType !== "notification")
          return yield* badRequest("EventSub message type does not match its body");
        const messageId = delivery.messageId;
        const occurredAt = delivery.messageTimestamp.getTime();
        if (!Number.isFinite(occurredAt)) return yield* badRequest("Invalid EventSub timestamp");
        if (yield* store.hasWebhookDelivery(messageId)) return { status: 204 };

        const byProvider = yield* store.findSubscriptionByProviderId(delivery.subscription.id);
        const subscription = Option.isSome(byProvider)
          ? byProvider
          : Option.fromNullishOr(
              (yield* store.listSubscriptions(account.value.id)).find((row) =>
                sameKey(row, {
                  type: delivery.subscription.type,
                  version: Number(delivery.subscription.version),
                  condition: delivery.subscription.condition,
                }),
              ),
            );
        if (Option.isNone(subscription)) {
          yield* store.recordWebhookDelivery(messageId, account.value.id, now);
          return { status: 204 };
        }

        const envelope: EventEnvelope = {
          id: `${Protocol.INTEGRATION}:${messageId}`,
          integration: Protocol.INTEGRATION,
          topic: Protocol.topicKey(delivery.subscription.type),
          connectionId: account.value.id,
          occurredAt,
          receivedAt: now,
          payload: asJson(delivery.event ?? null),
          onStale: subscription.value.onStale,
          maxAgeMs: subscription.value.maxAgeMs,
        };
        yield* relay
          .enqueueEvent(subscription.value.machineId, envelope)
          .pipe(Effect.mapError(() => internalError("The event could not be queued")));
        yield* store.recordWebhookDelivery(messageId, account.value.id, now);
        yield* store.pruneWebhookDeliveries(now - config.retentionMs);
        return { status: 204 };
      });

    const route = (request: HttpRequest): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const path = url.pathname;
        const hookRoute = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(path);
        if (hookRoute !== null) {
          const machineId = hookRoute[1];
          const hookId = hookRoute[2];
          if (machineId === undefined || hookId === undefined)
            return yield* notFound("Not found");
          return yield* handlePublicHook(
            request,
            decodeURIComponent(machineId),
            decodeURIComponent(hookId),
          );
        }
        if (request.method === "GET" && path === "/health")
          return json(200, { ok: true, service: "ballast-cloud" });
        if (request.method === "GET" && path === "/")
          return json(200, { name: "Ballast cloud", version: 1 });
        if (request.method === "GET" && path === "/oauth/twitch/start")
          return yield* handleOAuthStart(url);
        if (request.method === "GET" && path === "/oauth/twitch/callback")
          return yield* handleOAuthCallback(request, url);

        const webhook = /^\/webhooks\/twitch\/eventsub\/([^/]+)$/.exec(path);
        if (request.method === "POST" && webhook !== null) {
          const accountId = webhook[1];
          if (accountId === undefined) return yield* badRequest("Missing connection id");
          return yield* handleWebhook(request, decodeURIComponent(accountId));
        }

        if (request.method === "POST" && path === "/api/pairing/claim")
          return yield* handlePairingClaim(request);

        const machine = yield* authenticateMachine(request);
        const shareRoute = shares?.route(machine, request, url);
        if (shareRoute !== undefined) return yield* shareRoute;
        if (request.method === "GET" && path === "/api/connections")
          return yield* handleListConnections(machine);
        if (request.method === "POST" && path === "/api/hooks/register")
          return yield* handleRegisterHooks(machine, request);
        if (request.method === "POST" && path === "/api/hooks/unregister")
          return yield* handleUnregisterHooks(machine, request);
        if (request.method === "GET" && path === "/api/hooks")
          return yield* handleListHooks(machine);
        if (request.method === "POST" && path === "/api/tokens/twitch")
          return yield* handleGetToken(machine, request);
        if (request.method === "POST" && path === "/api/twitch/helix")
          return yield* handleHelix(machine, request);
        if (request.method === "POST" && path === "/api/twitch/subscriptions/reconcile") {
          const body = yield* decodeJson(ReconcileSubscriptionsRequest, request.body);
          return yield* reconcileSubscriptions(machine, body);
        }
        return yield* notFound("Not found");
      });

    const fetch = (request: HttpRequest): Effect.Effect<HttpResponse> =>
      route(request).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (error instanceof HttpError) return Effect.succeed(errorResponse(error));
          return Effect.logError("Unhandled Ballast cloud error", cause).pipe(
            Effect.as(errorResponse(internalError())),
          );
        }),
      );

    return { fetch, authenticateMachine };
  });

export const CloudAppLive = Layer.effect(
  CloudApp,
  Effect.gen(function* () {
    return CloudApp.of(
      yield* makeCloudApp({
        config: yield* CloudConfig,
        store: yield* CloudStore,
        vault: yield* TokenVault,
        twitch: yield* TwitchApi,
        relay: yield* RelayGateway,
      }),
    );
  }),
);
