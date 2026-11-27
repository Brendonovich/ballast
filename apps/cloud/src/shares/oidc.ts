import {
  DPoP,
  PrivateKeyJwt,
  allowInsecureRequests,
  authorizationCodeGrantRequest,
  calculatePKCECodeChallenge,
  discoveryRequest,
  generateKeyPair,
  generateRandomCodeVerifier,
  generateRandomNonce,
  generateRandomState,
  getValidatedIdTokenClaims,
  isDPoPNonceError,
  processAuthorizationCodeResponse,
  processDiscoveryResponse,
  processPushedAuthorizationResponse,
  pushedAuthorizationRequest,
  validateApplicationLevelSignature,
  validateAuthResponse,
  type AuthorizationServer,
  type Client,
  type ClientAuth,
} from "oauth4webapi";
import { Effect, Schema } from "effect";

import { HttpError, badRequest, unavailable, upstreamError } from "../errors.ts";

/**
 * Share-server sign-in (decision 0014): the cloud is an OpenID Connect
 * client of an issuer ("Sign in with Anomaly" by default). It runs the code
 * flow with PKCE S256, pushes the request to `/par` and signs every client
 * request with a `private_key_jwt` assertion, and binds the code to a DPoP key
 * when the issuer supports it. Only the validated ID token is used: the
 * user is `(iss, sub)`, never the email or username.
 */

/** A private EC P-256 JWK. */
const EcPrivateJwk = Schema.Struct({
  kty: Schema.String,
  crv: Schema.String,
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
});
type EcPrivateJwk = typeof EcPrivateJwk.Type;

/** What the callback needs to finish a sign-in; stored sealed between the two requests. */
export const SignInTransaction = Schema.Struct({
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.String,
  /** Private DPoP JWK for this sign-in, when the issuer supports DPoP. */
  dpopKey: Schema.NullOr(EcPrivateJwk),
});
export type SignInTransaction = typeof SignInTransaction.Type;

export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly name: string | null;
  readonly username: string | null;
}

export interface IdentityProviderService {
  readonly issuer: string;
  readonly start: (input: {
    readonly redirectUri: string;
  }) => Effect.Effect<{ readonly url: string; readonly transaction: SignInTransaction }, HttpError>;
  readonly finish: (input: {
    readonly callbackUrl: URL;
    readonly redirectUri: string;
    readonly transaction: SignInTransaction;
  }) => Effect.Effect<VerifiedIdentity, HttpError>;
}

/** A private ES256 JWK (`kty: EC`, `crv: P-256`, with `d`), optionally with a `kid`. */
export const ClientSigningKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
  kid: Schema.optionalKey(Schema.String),
});
export type ClientSigningKey = typeof ClientSigningKey.Type;

export interface OidcClientOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly signingKey: ClientSigningKey;
  /** Tests only: allow an http issuer. */
  readonly insecure?: boolean;
}

const ec = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The public half of a client signing key, for a JWKS or a client metadata document. */
export const publicJwk = (key: ClientSigningKey) => ({
  kty: key.kty,
  crv: key.crv,
  x: key.x,
  y: key.y,
  ...(key.kid === undefined ? {} : { kid: key.kid }),
  alg: "ES256",
  use: "sig",
});

export const parseSigningKey = (value: string): ClientSigningKey => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(ClientSigningKey))(value);
  } catch {
    throw new Error("must be a private ES256 (EC P-256) JWK");
  }
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeOidcIdentityProvider = (options: OidcClientOptions): IdentityProviderService => {
  const issuer = new URL(options.issuer);
  const client: Client = { client_id: options.clientId, id_token_signed_response_alg: "ES256" };
  const requestOptions = {
    signal: () => AbortSignal.timeout(8_000),
    ...(options.insecure === true ? { [allowInsecureRequests]: true } : {}),
  };

  let discovered: Promise<AuthorizationServer> | undefined;
  const server = () => {
    discovered ??= discoveryRequest(issuer, requestOptions)
      .then((response) => processDiscoveryResponse(issuer, response))
      .catch((cause: unknown) => {
        discovered = undefined;
        throw cause;
      });
    return discovered;
  };

  let auth: Promise<ClientAuth> | undefined;
  const clientAuth = () => {
    const { kid, ...jwk } = options.signingKey;
    auth ??= crypto.subtle
      .importKey("jwk", jwk, ec, false, ["sign"])
      .then((key) => PrivateKeyJwt(kid === undefined ? key : { key, kid }));
    return auth;
  };

  const proof = async (jwk: EcPrivateJwk | null) => {
    if (jwk === null) return undefined;
    const { kty, crv, x, y } = jwk;
    return DPoP(client, {
      publicKey: await crypto.subtle.importKey("jwk", { kty, crv, x, y }, ec, true, ["verify"]),
      privateKey: await crypto.subtle.importKey("jwk", { ...jwk }, ec, false, ["sign"]),
    });
  };

  // RFC 9449: the DPoP handle caches the issuer's nonce; one retry with a fresh proof.
  const withNonce = async <A>(send: () => Promise<A>): Promise<A> => {
    try {
      return await send();
    } catch (error) {
      if (!isDPoPNonceError(error)) throw error;
      return send();
    }
  };

  const unreachable = (cause: unknown) => upstreamError("Sign-in with the identity provider failed: " + messageOf(cause));

  return {
    issuer: issuer.href.replace(/\/$/, ""),

    start: ({ redirectUri }) =>
      Effect.tryPromise({
        try: async () => {
          const as = await server();
          const state = generateRandomState();
          const nonce = generateRandomNonce();
          const verifier = generateRandomCodeVerifier();
          let dpopKey: EcPrivateJwk | null = null;
          const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "openid profile",
            // A username for display; accounts without one pick one during sign-in.
            claims: JSON.stringify({ id_token: { preferred_username: { essential: true }, name: null } }),
            state,
            nonce,
            code_challenge_method: "S256",
            code_challenge: await calculatePKCECodeChallenge(verifier),
          });
          if (as.dpop_signing_alg_values_supported?.includes("ES256")) {
            const pair = await generateKeyPair("ES256", { extractable: true });
            const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
            if (exported instanceof ArrayBuffer) throw new Error("Could not export the DPoP key");
            const { kty, crv, x, y, d } = exported;
            if (kty === undefined || crv === undefined || x === undefined || y === undefined || d === undefined)
              throw new Error("Could not export the DPoP key");
            dpopKey = { kty, crv, x, y, d };
            const handle = await proof(dpopKey);
            if (handle !== undefined) params.set("dpop_jkt", await handle.calculateThumbprint());
          }
          if (as.authorization_endpoint === undefined) throw new Error("The issuer has no authorization endpoint");
          const authorize = new URL(as.authorization_endpoint);
          if (as.pushed_authorization_request_endpoint !== undefined) {
            const authentication = await clientAuth();
            const DPoP = await proof(dpopKey);
            const pushed = await withNonce(async () =>
              processPushedAuthorizationResponse(
                as,
                client,
                await pushedAuthorizationRequest(as, client, authentication, params, {
                  ...requestOptions,
                  ...(DPoP === undefined ? {} : { DPoP }),
                }),
              ),
            );
            authorize.searchParams.set("client_id", client.client_id);
            authorize.searchParams.set("request_uri", pushed.request_uri);
          } else {
            params.forEach((value, key) => authorize.searchParams.set(key, value));
          }
          return { url: authorize.href, transaction: { state, nonce, verifier, dpopKey } };
        },
        catch: unreachable,
      }),

    finish: ({ callbackUrl, redirectUri, transaction }) =>
      Effect.gen(function* () {
        const as = yield* Effect.tryPromise({ try: server, catch: unreachable });
        const params = yield* Effect.try({
          try: () => validateAuthResponse(as, client, callbackUrl, transaction.state),
          catch: (cause) => badRequest("The sign-in was not completed: " + messageOf(cause)),
        });
        return yield* Effect.tryPromise({
          try: async () => {
            const authentication = await clientAuth();
            const DPoP = await proof(transaction.dpopKey);
            const { response, tokens } = await withNonce(async () => {
              const response = await authorizationCodeGrantRequest(
                as,
                client,
                authentication,
                params,
                redirectUri,
                transaction.verifier,
                { ...requestOptions, ...(DPoP === undefined ? {} : { DPoP }) },
              );
              const tokens = await processAuthorizationCodeResponse(as, client, response, {
                expectedNonce: transaction.nonce,
                requireIdToken: true,
              });
              return { response, tokens };
            });
            await validateApplicationLevelSignature(as, response, requestOptions);
            const claims = getValidatedIdTokenClaims(tokens);
            if (claims === undefined) throw new Error("The issuer returned no ID token");
            const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);
            return {
              issuer: claims.iss,
              subject: claims.sub,
              name: text(claims["name"]),
              username: text(claims["preferred_username"]),
            };
          },
          catch: unreachable,
        });
      }),
  };
};

/** Sign-in answers 503 until the cloud has a client registration. */
export const unconfiguredIdentityProvider = (issuer: string): IdentityProviderService => {
  const off = Effect.fail(
    unavailable("Sign-in is not configured on this share server (set ANOMALY_CLIENT_KEY)"),
  );
  return { issuer, start: () => off, finish: () => off };
};
