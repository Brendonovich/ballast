import { EventSub, Protocol } from "@ballast/module-twitch";
import {
  HelixRequest,
  PairingClaimRequest,
  ReconcileSubscriptionsRequest,
  conditionKey,
  subscriptionKey,
  twitchSubscriptionCost,
  type EventEnvelope,
  type PairingClaimResponse,
  type TwitchConnection,
  type TwitchSubscription,
} from "@ballast/cloud-protocol";
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect";

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
  unauthorized,
  upstreamError,
  HttpError,
} from "./errors.ts";
import { RelayGateway, type RelayGatewayService } from "./relay/gateway.ts";
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
  type SubscriptionRow,
  type TwitchAccountRow,
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

const toConnection = (
  account: TwitchAccountRow,
): TwitchConnection & { readonly needsReauth: boolean } => ({
  id: account.id,
  twitchUserId: account.twitchUserId,
  login: account.login,
  displayName: account.displayName,
  scopes: [...account.scopes],
  machineId: account.machineId,
  createdAt: account.createdAt,
  needsReauth: account.needsReauth,
});

const toSubscription = (row: SubscriptionRow): TwitchSubscription => ({
  id: row.id,
  providerSubscriptionId: row.providerSubscriptionId,
  type: row.type,
  version: row.version,
  condition: row.condition,
  status: row.status,
  cost: row.cost,
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

const belongsToAccount = (
  condition: Readonly<Record<string, string>>,
  twitchUserId: string,
): boolean =>
  Object.keys(condition).length > 0 &&
  Object.values(condition).every((value) => value === twitchUserId);

const errorBody = (error: HttpError): unknown => ({
  error: {
    tag: error.tag,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});

const errorResponse = (error: HttpError): HttpResponse => json(error.status, errorBody(error));

/**
 * EventSub revocations we can recover from without the user reconnecting.
 * Every other reason (authorization/user removal, version removal, limits)
 * needs a person or a manifest change.
 */
const recoverableRevocation = (reason: string): boolean =>
  reason === "notification_failures_exceeded";

const WebhookSubscription = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  type: Schema.String,
  version: Schema.String,
  condition: Schema.Record(Schema.String, Schema.String),
});
type WebhookSubscription = Schema.Schema.Type<typeof WebhookSubscription>;

const WebhookBodyOnly = Schema.Union([
  Schema.Struct({ subscription: WebhookSubscription, challenge: Schema.String }),
  Schema.Struct({ subscription: WebhookSubscription, event: Schema.Unknown }),
  Schema.Struct({ subscription: WebhookSubscription }),
]);

type WebhookDelivery =
  | {
      readonly _tag: "verification";
      readonly challenge: string;
      readonly subscription: WebhookSubscription;
    }
  | {
      readonly _tag: "notification";
      readonly subscription: WebhookSubscription;
      readonly event: unknown;
    }
  | {
      readonly _tag: "revocation";
      readonly subscription: WebhookSubscription;
    };

/**
 * Twitch's webhook envelope, with the same lenient body-only acceptance that
 * Twitch CLI uses. The module's typed notification decoder is deliberately
 * not used here: the gateway relays payloads without knowing every topic's
 * schema, and the agent decodes them against its integration catalog.
 */
const parseWebhook = (body: string): Effect.Effect<WebhookDelivery, HttpError> =>
  Effect.gen(function* () {
    const jsonValue = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      body,
    ).pipe(Effect.mapError(() => badRequest("Invalid EventSub delivery")));

    const envelope = Option.getOrUndefined(
      Schema.decodeUnknownOption(EventSub.EventSubWebhookMessage)(jsonValue),
    );
    if (envelope !== undefined) {
      if (EventSub.isWebhookMessageType(envelope, "webhook_callback_verification"))
        return {
          _tag: "verification" as const,
          challenge: envelope.payload.challenge,
          subscription: envelope.payload.subscription,
        };
      if (EventSub.isWebhookMessageType(envelope, "notification"))
        return {
          _tag: "notification" as const,
          subscription: envelope.payload.subscription,
          event: envelope.payload.event,
        };
      return {
        _tag: "revocation" as const,
        subscription: envelope.payload.subscription,
      };
    }

    const bodyOnly = yield* Schema.decodeUnknownEffect(WebhookBodyOnly)(jsonValue).pipe(
      Effect.mapError(() => badRequest("Invalid EventSub delivery")),
    );
    if ("challenge" in bodyOnly)
      return {
        _tag: "verification" as const,
        challenge: bodyOnly.challenge,
        subscription: bodyOnly.subscription,
      };
    if ("event" in bodyOnly)
      return {
        _tag: "notification" as const,
        subscription: bodyOnly.subscription,
        event: bodyOnly.event,
      };
    return { _tag: "revocation" as const, subscription: bodyOnly.subscription };
  });

export interface CloudAppDeps {
  readonly config: CloudConfigService;
  readonly store: CloudStoreService;
  readonly vault: TokenVaultService;
  readonly twitch: TwitchApiService;
  readonly relay: RelayGatewayService;
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
      now: number,
    ): Effect.Effect<void, HttpError> =>
      Effect.gen(function* () {
        const windowStart = Math.floor(now / PAIRING_RATE_WINDOW_MS) * PAIRING_RATE_WINDOW_MS;
        const count = yield* store.incrementRateLimit({
          key: bucket,
          windowStart,
          expiresAt: windowStart + PAIRING_RATE_WINDOW_MS,
        });
        yield* store.pruneRateLimits(now);
        if (count > limit)
          return yield* rateLimited("Too many attempts; try again later", {
            limit,
            windowMs: PAIRING_RATE_WINDOW_MS,
          });
      });

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
        const desired = new Map<string, ReconcileSubscriptionsRequest["subscriptions"][number]>();
        for (const spec of request.subscriptions) {
          if (!belongsToAccount(spec.condition, account.twitchUserId))
            return yield* badRequest(
              "Every EventSub condition value must be this Twitch account's user id",
              { condition: spec.condition },
            );
          if (spec.type.length === 0 || spec.version < 1 || spec.maxAgeMs < 0)
            return yield* badRequest("Invalid EventSub subscription spec", { spec });
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

        const totalCost = [...desired.values()].reduce(
          (total, spec) => total + twitchSubscriptionCost(spec.type),
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

        // Remove provider subscriptions this manifest no longer wants.
        for (const subscription of ours) {
          const key = subscriptionKey({
            type: subscription.type,
            version: Number(subscription.version),
            condition: subscription.condition,
          });
          if (desired.has(key)) continue;
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
        const previousRows = yield* store.listSubscriptions(account.id);
        const rows: Array<SubscriptionRow> = [];

        for (const [key, spec] of desired) {
          const previous = previousRows.find((row) => sameKey(row, spec));
          const provider = ours.find(
            (candidate) =>
              subscriptionKey({
                type: candidate.type,
                version: Number(candidate.version),
                condition: candidate.condition,
              }) === key,
          );
          const id = previous?.id ?? crypto.randomUUID();
          const base: SubscriptionRow = {
            id,
            accountId: account.id,
            machineId: machine.id,
            type: spec.type,
            version: spec.version,
            condition: spec.condition,
            cost: twitchSubscriptionCost(spec.type),
            providerSubscriptionId: provider?.id ?? previous?.providerSubscriptionId ?? null,
            status: provider === undefined ? "pending" : "enabled",
            onStale: spec.onStale,
            maxAgeMs: spec.maxAgeMs,
            lastError: null,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };

          if (provider !== undefined) {
            yield* store.upsertSubscription(base);
            rows.push(base);
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
          rows.push(row);
        }

        for (const previous of previousRows) {
          if (![...desired.values()].some((spec) => sameKey(previous, spec)))
            yield* store.deleteSubscription(previous.id);
        }

        return json(200, {
          subscriptions: rows.map(toSubscription),
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

        yield* enforceRateLimit(`pairing-create:${userId}`, PAIRING_CODE_CREATE_LIMIT, now);

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
<p>Enter this pairing code in Ballast on your machine:</p>
<p style="font-size: 2rem; letter-spacing: 0.2em; font-weight: 700">${escapeHtml(pairingCode)}</p>
<p>It expires in 15 minutes. You can close this tab.</p>
</body></html>`,
        );
      });

    const handlePairingClaim = (request: HttpRequest): Effect.Effect<HttpResponse, HttpError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* enforceRateLimit(
          `pairing-claim:${clientIp(request)}`,
          PAIRING_CLAIM_LIMIT,
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
      subscription: WebhookSubscription,
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

        yield* EventSub.verifyWebhook({
          headers: request.headers,
          body: request.body,
          secret: webhookSecret,
          now,
          toleranceMs: config.webhookTimestampToleranceMs,
        }).pipe(
          Effect.mapError((failure) =>
            failure.code === "missing-header" ||
            failure.code === "invalid-timestamp" ||
            failure.code === "crypto-unavailable"
              ? badRequest(failure.message)
              : forbidden(failure.message),
          ),
        );

        const delivery = yield* parseWebhook(new TextDecoder().decode(request.body));
        if (!belongsToAccount(delivery.subscription.condition, account.value.twitchUserId))
          return yield* badRequest("EventSub condition does not belong to this connection");

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
        const messageId = header(request, EventSub.MESSAGE_ID_HEADER);
        const timestamp = header(request, EventSub.MESSAGE_TIMESTAMP_HEADER);
        if (messageId === undefined || timestamp === undefined)
          return yield* badRequest("Missing Twitch EventSub headers");
        const occurredAt = Date.parse(timestamp);
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
        if (request.method === "GET" && path === "/api/connections")
          return yield* handleListConnections(machine);
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
