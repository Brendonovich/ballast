import {
  SHARE_AUTH_CALLBACK_PATH,
  SHARE_AUTH_LOGIN_PATH,
  SHARE_AUTH_LOGOUT_PATH,
  SHARE_AUTH_ME_PATH,
  SHARE_AUTH_TOKEN_PATH,
  ShareAuthTokenRequest,
  type ShareAuthMeResponse,
  type ShareAuthTokenResponse,
  type ShareUser,
} from "@ballast/cloud-protocol";
import { Clock, Effect, Option, Result, Schema } from "effect";

import type { CloudConfigService } from "../config.ts";
import { HttpError, badRequest, internalError, unauthorized } from "../errors.ts";
import { bearerToken, clientIp, decodeJson, escapeHtml, html, json, redirect } from "../http.ts";
import type { HttpRequest, HttpResponse } from "../http.ts";
import { SealedSecret, hashMachineToken, randomToken, type TokenVaultService } from "../secrets.ts";
import type { CloudStoreService, ShareSessionRow, ShareUserRow } from "../store.ts";
import { SignInTransaction, publicJwk, type ClientSigningKey, type IdentityProviderService } from "./oidc.ts";

/** Path of the client ID metadata document this server can sign in with. */
export const SHARE_AUTH_CLIENT_METADATA_PATH = "/api/shares/auth/client.json";

const SIGN_IN_TTL_MS = 15 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
/** Sessions not used for this long stop working and are pruned. */
export const SHARE_SESSION_IDLE_MS = 90 * 24 * 60 * 60_000;
const TOUCH_INTERVAL_MS = 60_000;
const SIGN_INS_PER_WINDOW = 30;
const SIGN_IN_WINDOW_MS = 15 * 60_000;
const deviceNameLimit = 80;

/** Who a share-server bearer token belongs to. */
export interface SharePrincipal {
  readonly session: ShareSessionRow;
  readonly user: ShareUserRow;
}

export interface ShareAuthDeps {
  readonly config: CloudConfigService;
  readonly store: CloudStoreService;
  readonly vault: TokenVaultService;
  readonly provider: IdentityProviderService;
  readonly enforceRateLimit: (
    bucket: string,
    limit: number,
    windowMs: number,
    now: number,
  ) => Effect.Effect<void, HttpError>;
}

/** The sealed state between `/login` and the issuer's callback. */
const PendingSignIn = Schema.Struct({
  transaction: SignInTransaction,
  /** The agent's loopback redirect, its state and its S256 challenge. */
  redirectUri: Schema.String,
  agentState: Schema.String,
  codeChallenge: Schema.String,
});
type PendingSignIn = typeof PendingSignIn.Type;
const PendingJson = Schema.fromJsonString(PendingSignIn);
const SealedJson = Schema.fromJsonString(SealedSecret);

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Codes go back to the agent on this machine only: plain-http loopback
 * (any port, RFC 8252 §7.3). Anything else would be an open redirect.
 */
const loopbackRedirect = (value: string | null): URL | undefined => {
  if (value === null) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && loopbackHosts.has(url.hostname) && url.username === "" &&
      url.password === "" && url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const base64UrlPattern = (min: number, max: number) => new RegExp("^[A-Za-z0-9._~-]{" + min + "," + max + "}$");
const statePattern = base64UrlPattern(8, 256);
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern = base64UrlPattern(43, 128);

const s256 = async (verifier: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const page = (title: string, body: string): HttpResponse =>
  html(
    200,
    `<!doctype html><html><head><meta charset="utf-8"><title>Ballast</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; line-height: 1.5">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
</body></html>`,
  );

export const shareUserOf = (row: ShareUserRow): ShareUser => ({
  id: row.id,
  issuer: row.issuer,
  name: row.name,
  username: row.username,
});

/** A client ID metadata document for this server, for issuers that accept one as `client_id`. */
export const shareClientMetadata = (origin: string, signingKey: ClientSigningKey) => ({
  client_id: origin + SHARE_AUTH_CLIENT_METADATA_PATH,
  client_name: "Ballast",
  application_type: "web",
  redirect_uris: [origin + SHARE_AUTH_CALLBACK_PATH],
  grant_types: ["authorization_code"],
  response_types: ["code"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_signing_alg: "ES256",
  id_token_signed_response_alg: "ES256",
  jwks: { keys: [publicJwk(signingKey)] },
});

/**
 * Share-server sign-in (decision 0014). The browser half
 * (`/login` → issuer → `/callback` → the agent's loopback redirect) and
 * the agent half (`/token` with the PKCE verifier → a bearer token), plus
 * bearer-token authentication for `/api/shares/*`.
 */
export const makeShareAuth = (deps: ShareAuthDeps) => {
  const { config, store, vault, provider } = deps;
  const callbackUri = config.publicOrigin + SHARE_AUTH_CALLBACK_PATH;

  const seal = (pending: PendingSignIn) =>
    vault.seal(Schema.encodeSync(PendingJson)(pending)).pipe(
      Effect.map((sealed) => Schema.encodeSync(SealedJson)(sealed)),
      Effect.mapError(() => internalError("The sign-in could not be stored")),
    );

  const open = (payload: string) =>
    Effect.gen(function* () {
      const sealed = yield* Schema.decodeUnknownEffect(SealedJson)(payload);
      const plaintext = yield* vault.open(sealed);
      return yield* Schema.decodeUnknownEffect(PendingJson)(plaintext);
    }).pipe(Effect.mapError(() => internalError("The stored sign-in could not be read")));

  const backToAgent = (pending: PendingSignIn, params: Record<string, string>): HttpResponse => {
    const target = new URL(pending.redirectUri);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    target.searchParams.set("state", pending.agentState);
    return redirect(target.href);
  };

  const login = (request: HttpRequest, url: URL) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* deps.enforceRateLimit("share-sign-in:" + clientIp(request), SIGN_INS_PER_WINDOW, SIGN_IN_WINDOW_MS, now);
      const redirectUri = loopbackRedirect(url.searchParams.get("redirect_uri"));
      if (redirectUri === undefined)
        return yield* badRequest("redirect_uri must be an http://127.0.0.1, localhost or [::1] URL");
      const agentState = url.searchParams.get("state") ?? "";
      if (!statePattern.test(agentState)) return yield* badRequest("state is missing or malformed");
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (url.searchParams.get("code_challenge_method") !== "S256" || !challengePattern.test(codeChallenge))
        return yield* badRequest("An S256 code_challenge is required");
      const started = yield* provider.start({ redirectUri: callbackUri });
      yield* store.pruneShareAuth(now, now - SHARE_SESSION_IDLE_MS);
      yield* store.insertShareSignIn({
        state: started.transaction.state,
        payload: yield* seal({
          transaction: started.transaction,
          redirectUri: redirectUri.href,
          agentState,
          codeChallenge,
        }),
        createdAt: now,
        expiresAt: now + SIGN_IN_TTL_MS,
      });
      return redirect(started.url);
    });

  const callback = (url: URL) =>
    Effect.gen(function* () {
      const state = url.searchParams.get("state");
      const now = yield* Clock.currentTimeMillis;
      const stored = state === null ? Option.none() : yield* store.takeShareSignIn(state, now);
      if (Option.isNone(stored))
        return page("Sign-in expired", "This sign-in link has expired or was already used. Start again from Ballast.");
      const pending = yield* open(stored.value.payload);
      const error = url.searchParams.get("error");
      if (error !== null) return backToAgent(pending, { error });
      const finished = yield* Effect.result(
        provider.finish({ callbackUrl: url, redirectUri: callbackUri, transaction: pending.transaction }),
      );
      // The agent is waiting on its loopback redirect; tell it rather than strand the browser.
      if (Result.isFailure(finished))
        return backToAgent(pending, { error: "server_error", error_description: finished.failure.message });
      const identity = finished.success;
      const user = yield* store.upsertShareUser({
        id: "usr_" + randomToken(12),
        issuer: identity.issuer,
        subject: identity.subject,
        name: identity.name,
        username: identity.username,
        createdAt: now,
        updatedAt: now,
      });
      const code = randomToken(32);
      yield* store.insertShareAuthCode({
        codeHash: yield* Effect.promise(() => hashMachineToken(config.tokenPepper, code)),
        userId: user.id,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
      });
      return backToAgent(pending, { code });
    });

  const token = (request: HttpRequest) =>
    Effect.gen(function* () {
      const body = yield* decodeJson(ShareAuthTokenRequest, request.body);
      const now = yield* Clock.currentTimeMillis;
      const invalid = new HttpError({ status: 400, tag: "invalid_request", message: "The sign-in code is invalid or has expired; sign in again" });
      if (!verifierPattern.test(body.codeVerifier)) return yield* invalid;
      const hash = yield* Effect.promise(() => hashMachineToken(config.tokenPepper, body.code));
      const code = yield* store.takeShareAuthCode(hash, now);
      if (Option.isNone(code)) return yield* invalid;
      if ((yield* Effect.promise(() => s256(body.codeVerifier))) !== code.value.codeChallenge) return yield* invalid;
      const user = yield* store.findShareUser(code.value.userId);
      if (Option.isNone(user)) return yield* invalid;
      const sessionToken = "blst_s_" + randomToken(32);
      yield* store.insertShareSession({
        id: "ses_" + randomToken(12),
        userId: user.value.id,
        tokenHash: yield* Effect.promise(() => hashMachineToken(config.tokenPepper, sessionToken)),
        deviceName: body.deviceName?.trim().slice(0, deviceNameLimit) || "Ballast",
        createdAt: now,
        lastUsedAt: now,
      });
      return json(200, { token: sessionToken, user: shareUserOf(user.value) } satisfies ShareAuthTokenResponse);
    });

  const authenticate = (request: HttpRequest): Effect.Effect<SharePrincipal, HttpError> =>
    Effect.gen(function* () {
      const signIn = unauthorized("Sign in to this share server first");
      const value = bearerToken(request);
      if (value === undefined || !value.startsWith("blst_s_")) return yield* signIn;
      const hash = yield* Effect.promise(() => hashMachineToken(config.tokenPepper, value));
      const session = yield* store.findShareSessionByTokenHash(hash);
      const now = yield* Clock.currentTimeMillis;
      if (Option.isNone(session) || session.value.lastUsedAt < now - SHARE_SESSION_IDLE_MS) return yield* signIn;
      const user = yield* store.findShareUser(session.value.userId);
      if (Option.isNone(user)) return yield* signIn;
      if (now - session.value.lastUsedAt > TOUCH_INTERVAL_MS) yield* store.touchShareSession(session.value.id, now);
      return { session: session.value, user: user.value };
    });

  /** Undefined when the path is not a sign-in route. */
  const route = (request: HttpRequest, url: URL): Effect.Effect<HttpResponse, HttpError> | undefined => {
    const path = url.pathname;
    const method = request.method;
    if (method === "GET" && path === SHARE_AUTH_LOGIN_PATH) return login(request, url);
    if (method === "GET" && path === SHARE_AUTH_CALLBACK_PATH) return callback(url);
    if (method === "POST" && path === SHARE_AUTH_TOKEN_PATH) return token(request);
    if (method === "GET" && path === SHARE_AUTH_ME_PATH)
      return Effect.map(authenticate(request), (principal) =>
        json(200, { user: shareUserOf(principal.user) } satisfies ShareAuthMeResponse),
      );
    if (method === "POST" && path === SHARE_AUTH_LOGOUT_PATH)
      return Effect.gen(function* () {
        const principal = yield* authenticate(request);
        yield* store.deleteShareSession(principal.session.id);
        return json(200, { ok: true });
      });
    if (method === "GET" && path === SHARE_AUTH_CLIENT_METADATA_PATH) {
      const key = config.shareSignIn.signingKey;
      return key === undefined
        ? undefined
        : Effect.succeed(
            json(200, shareClientMetadata(config.publicOrigin, key), { "cache-control": "public, max-age=300" }),
          );
    }
    return undefined;
  };

  return { route, authenticate };
};
