import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Twitch's OAuth 2.0 endpoints for the local own-app mode: authorization-code
 * with PKCE-less localhost callback, refresh, validation, device-code for
 * public clients, and revocation. Every base URL is injectable for tests and
 * for a proxy in the cloud.
 */

export const DEFAULT_AUTHORIZATION_URL = "https://id.twitch.tv/oauth2/authorize";
export const DEFAULT_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const DEFAULT_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
export const DEFAULT_DEVICE_URL = "https://id.twitch.tv/oauth2/device";
export const DEFAULT_REVOKE_URL = "https://id.twitch.tv/oauth2/revoke";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export class OAuthError extends Schema.TaggedError<OAuthError>()("TwitchOAuthError", {
  reason: Schema.String,
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
}) {
  override get message() {
    return this.reason;
  }
}

export interface OAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresIn: number;
  readonly scopes: ReadonlyArray<string>;
  readonly tokenType: string;
}

export interface AuthorizeOptions {
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  /** Opaque CSRF value; the callback helper checks it. */
  readonly state: string;
  readonly forceVerify?: boolean;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly intervalSeconds: number;
}

export type DeviceTokenPoll =
  | { readonly _tag: "pending"; readonly intervalSeconds: number }
  | { readonly _tag: "slow-down"; readonly intervalSeconds: number }
  | { readonly _tag: "authorized"; readonly token: OAuthToken };

export interface TokenValidation {
  readonly clientId: string;
  readonly login: string;
  readonly scopes: ReadonlyArray<string>;
  readonly userId: string;
  readonly expiresIn: number;
}

export interface OAuthConfig {
  readonly clientId: string;
  /** Confidential clients only; device-code flow works without it. */
  readonly clientSecret?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly validateUrl?: string;
  readonly deviceUrl?: string;
  readonly revokeUrl?: string;
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  scope: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.String])),
  token_type: Schema.String,
});
type TokenResponse = Schema.Schema.Type<typeof TokenResponse>;

const ErrorResponse = Schema.Struct({
  status: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});

const ValidationResponse = Schema.Struct({
  client_id: Schema.String,
  login: Schema.String,
  scopes: Schema.Array(Schema.String),
  user_id: Schema.String,
  expires_in: Schema.Number,
});

const toScopes = (scope: ReadonlyArray<string> | string | undefined): ReadonlyArray<string> =>
  scope === undefined
    ? []
    : typeof scope === "string"
      ? scope.split(" ").filter((value) => value.length > 0)
      : scope;

const toToken = (response: TokenResponse): OAuthToken => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  expiresIn: response.expires_in,
  scopes: toScopes(response.scope),
  tokenType: response.token_type,
});

const errorCode = (body: Schema.Schema.Type<typeof ErrorResponse>): string | undefined =>
  body.error ?? body.message;

const errorReason = (body: Schema.Schema.Type<typeof ErrorResponse>): string =>
  body.error_description ?? body.message ?? body.error ?? "Twitch OAuth request failed";

const formRequest = (url: string, params: Readonly<Record<string, string>>) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader("Accept", "application/json"),
    HttpClientRequest.bodyUrlParams(params),
  );

export interface OAuthClientService {
  readonly config: OAuthConfig;
  readonly authorizeUrl: (options: AuthorizeOptions) => string;
  readonly exchangeCode: (input: {
    readonly code: string;
    readonly redirectUri: string;
  }) => Effect.Effect<OAuthToken, OAuthError>;
  readonly refreshToken: (refreshToken: string) => Effect.Effect<OAuthToken, OAuthError>;
  readonly validateToken: (accessToken: string) => Effect.Effect<TokenValidation, OAuthError>;
  readonly startDeviceAuthorization: (
    scopes: ReadonlyArray<string>,
  ) => Effect.Effect<DeviceAuthorization, OAuthError>;
  readonly pollDeviceToken: (input: {
    readonly deviceCode: string;
    readonly scopes?: ReadonlyArray<string>;
    readonly intervalSeconds?: number;
  }) => Effect.Effect<DeviceTokenPoll, OAuthError>;
  readonly waitForDeviceToken: (input: {
    readonly deviceCode: string;
    readonly scopes?: ReadonlyArray<string>;
    readonly intervalSeconds?: number;
    readonly expiresIn?: number;
  }) => Effect.Effect<OAuthToken, OAuthError>;
  readonly revoke: (token: string) => Effect.Effect<void, OAuthError>;
}

export class OAuthClient extends Context.Service<OAuthClient, OAuthClientService>()(
  "Twitch/OAuthClient",
) {}

export const make = (
  config: OAuthConfig,
): Effect.Effect<OAuthClientService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
    const validateUrl = config.validateUrl ?? DEFAULT_VALIDATE_URL;
    const deviceUrl = config.deviceUrl ?? DEFAULT_DEVICE_URL;
    const revokeUrl = config.revokeUrl ?? DEFAULT_REVOKE_URL;
    const authorizationUrl = config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL;

    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(request).pipe(
        Effect.mapError(
          (cause) => new OAuthError({ reason: cause.message, code: "transport-error" }),
        ),
      );

    const readJson = (response: { readonly json: Effect.Effect<unknown, unknown> }) =>
      response.json.pipe(
        Effect.mapError(
          () => new OAuthError({ reason: "Twitch returned an invalid JSON response" }),
        ),
      );

    const clientParams = (): Readonly<Record<string, string>> =>
      config.clientSecret === undefined
        ? { client_id: config.clientId }
        : { client_id: config.clientId, client_secret: config.clientSecret };

    const tokenRequest = (
      params: Readonly<Record<string, string>>,
    ): Effect.Effect<OAuthToken, OAuthError> =>
      Effect.gen(function* () {
        const response = yield* execute(formRequest(tokenUrl, params));
        const body = yield* readJson(response);
        if (response.status < 200 || response.status >= 300) {
          const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorResponse)(body));
          const code = parsed === undefined ? undefined : errorCode(parsed);
          return yield* new OAuthError({
            reason:
              parsed === undefined
                ? "Twitch OAuth request failed (" + response.status + ")"
                : errorReason(parsed),
            status: response.status,
            ...(code === undefined ? {} : { code }),
          });
        }
        const decoded = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthError({
                reason: "Twitch returned an invalid token response: " + cause.message,
                status: response.status,
              }),
          ),
        );
        return toToken(decoded);
      });

    const exchangeCode: OAuthClientService["exchangeCode"] = (input) =>
      tokenRequest({
        ...clientParams(),
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
      });

    const refreshToken: OAuthClientService["refreshToken"] = (refreshToken) =>
      tokenRequest({
        ...clientParams(),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

    const validateToken: OAuthClientService["validateToken"] = (accessToken) =>
      Effect.gen(function* () {
        const response = yield* execute(
          HttpClientRequest.get(validateUrl).pipe(
            HttpClientRequest.setHeader("Authorization", "OAuth " + accessToken),
            HttpClientRequest.setHeader("Accept", "application/json"),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new OAuthError({
            reason: "Twitch rejected the access token",
            code: "invalid-token",
            status: response.status,
          });
        }
        const body = yield* readJson(response);
        const decoded = yield* Schema.decodeUnknownEffect(ValidationResponse)(body).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthError({
                reason: "Twitch returned an invalid token validation: " + cause.message,
                status: response.status,
              }),
          ),
        );
        return {
          clientId: decoded.client_id,
          login: decoded.login,
          scopes: decoded.scopes,
          userId: decoded.user_id,
          expiresIn: decoded.expires_in,
        };
      });

    const startDeviceAuthorization: OAuthClientService["startDeviceAuthorization"] = (scopes) =>
      Effect.gen(function* () {
        const response = yield* execute(
          formRequest(deviceUrl, {
            client_id: config.clientId,
            scopes: scopes.join(" "),
          }),
        );
        const body = yield* readJson(response);
        if (response.status < 200 || response.status >= 300) {
          const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorResponse)(body));
          const code = parsed === undefined ? undefined : errorCode(parsed);
          return yield* new OAuthError({
            reason:
              parsed === undefined
                ? "Twitch device authorization failed (" + response.status + ")"
                : errorReason(parsed),
            status: response.status,
            ...(code === undefined ? {} : { code }),
          });
        }
        const decoded = yield* Schema.decodeUnknownEffect(DeviceAuthorizationResponse)(body).pipe(
          Effect.mapError(
            (cause) =>
              new OAuthError({
                reason: "Twitch returned an invalid device authorization: " + cause.message,
                status: response.status,
              }),
          ),
        );
        return {
          deviceCode: decoded.device_code,
          userCode: decoded.user_code,
          verificationUri: decoded.verification_uri,
          expiresIn: decoded.expires_in,
          intervalSeconds: decoded.interval,
        };
      });

    const pollDeviceToken: OAuthClientService["pollDeviceToken"] = (input) =>
      Effect.gen(function* () {
        const interval = input.intervalSeconds ?? 5;
        const response = yield* execute(
          formRequest(tokenUrl, {
            ...clientParams(),
            device_code: input.deviceCode,
            grant_type: DEVICE_CODE_GRANT_TYPE,
            ...(input.scopes === undefined ? {} : { scopes: input.scopes.join(" ") }),
          }),
        );
        const body = yield* readJson(response);
        if (response.status >= 200 && response.status < 300) {
          const decoded = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthError({
                  reason: "Twitch returned an invalid token response: " + cause.message,
                  status: response.status,
                }),
            ),
          );
          return { _tag: "authorized" as const, token: toToken(decoded) };
        }

        const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorResponse)(body));
        const code = parsed === undefined ? undefined : errorCode(parsed);
        if (code === "authorization_pending") {
          return { _tag: "pending" as const, intervalSeconds: interval };
        }
        if (code === "slow_down") {
          return { _tag: "slow-down" as const, intervalSeconds: interval + 5 };
        }
        return yield* new OAuthError({
          reason:
            parsed === undefined
              ? "Twitch device authorization failed (" + response.status + ")"
              : errorReason(parsed),
          status: response.status,
          ...(code === undefined ? {} : { code }),
        });
      });

    const waitForDeviceToken: OAuthClientService["waitForDeviceToken"] = (input) =>
      Effect.gen(function* () {
        let interval = input.intervalSeconds ?? 5;
        const expiresIn = input.expiresIn ?? 1800;
        const deadline = Date.now() + expiresIn * 1000;
        while (true) {
          const result = yield* pollDeviceToken({
            deviceCode: input.deviceCode,
            intervalSeconds: interval,
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
          });
          if (result._tag === "authorized") return result.token;
          interval = result.intervalSeconds;
          if (Date.now() >= deadline) {
            return yield* new OAuthError({
              reason: "The Twitch device code expired before it was approved",
              code: "expired_token",
            });
          }
          yield* Effect.sleep(Duration.seconds(interval));
        }
      });

    const revoke: OAuthClientService["revoke"] = (token) =>
      Effect.gen(function* () {
        const response = yield* execute(
          formRequest(revokeUrl, { client_id: config.clientId, token }),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* new OAuthError({
            reason: "Twitch could not revoke the token (" + response.status + ")",
            status: response.status,
          });
        }
      });

    return {
      config,
      authorizeUrl: (options) => {
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: options.redirectUri,
          response_type: "code",
          scope: options.scopes.join(" "),
          state: options.state,
        });
        if (options.forceVerify === true) params.set("force_verify", "true");
        return authorizationUrl + "?" + params.toString();
      },
      exchangeCode,
      refreshToken,
      validateToken,
      startDeviceAuthorization,
      pollDeviceToken,
      waitForDeviceToken,
      revoke,
    };
  });

export const layer = (
  config: OAuthConfig,
): Layer.Layer<OAuthClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    OAuthClient,
    Effect.map(make(config), (service) => OAuthClient.of(service)),
  );
