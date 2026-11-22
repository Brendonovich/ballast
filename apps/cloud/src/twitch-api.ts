import { Helix, OAuth, Protocol } from "@ballast/module-twitch";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { CloudConfig, type CloudConfigService } from "./config.ts";

export class TwitchError extends Data.TaggedError("TwitchError")<{
  readonly operation: string;
  readonly status: number;
  readonly message: string;
  readonly body?: unknown;
}> {}

export interface TwitchTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scopes: ReadonlyArray<string>;
}

export interface TwitchUser {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  /** `/helix/users` only returns the email with `user:read:email`; the shared User schema omits it. */
  readonly email: string | null;
}

export interface TwitchProviderSubscription {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly condition: Readonly<Record<string, string>>;
  readonly status: string;
  readonly transport: {
    readonly method: string;
    readonly callback: string | null;
  };
}

export interface CreateEventSubSubscription {
  readonly type: string;
  readonly version: number;
  readonly condition: Readonly<Record<string, string>>;
  readonly callback: string;
  readonly secret: string;
}

export interface HelixCall {
  readonly accessToken: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly body?: unknown;
}

export interface TwitchApiService {
  readonly authorizeUrl: (input: {
    readonly redirectUri: string;
    readonly scopes: ReadonlyArray<string>;
    readonly state: string;
    readonly forceVerify?: boolean;
  }) => string;
  readonly exchangeAuthorizationCode: (
    code: string,
    redirectUri: string,
  ) => Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly refresh: (refreshToken: string) => Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly validateToken: (accessToken: string) => Effect.Effect<
    { readonly userId: string; readonly login: string; readonly scopes: ReadonlyArray<string>; readonly expiresAt: number },
    TwitchError
  >;
  readonly clientCredentials: Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly getUser: (accessToken: string) => Effect.Effect<TwitchUser, TwitchError>;
  /** Raw Helix passthrough for the agent proxy; non-2xx responses are returned, not raised. */
  readonly helix: (call: HelixCall) => Effect.Effect<{ status: number; body: unknown }, TwitchError>;
  readonly createEventSubSubscription: (
    appAccessToken: string,
    input: CreateEventSubSubscription,
  ) => Effect.Effect<{ id: string }, TwitchError>;
  readonly deleteEventSubSubscription: (
    appAccessToken: string,
    id: string,
  ) => Effect.Effect<void, TwitchError>;
  readonly listEventSubSubscriptions: (
    appAccessToken: string,
  ) => Effect.Effect<ReadonlyArray<TwitchProviderSubscription>, TwitchError>;
}

export class TwitchApi extends Context.Service<TwitchApi, TwitchApiService>()(
  "Ballast/TwitchApi",
) {}

const ClientCredentialsResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expires_in: Schema.Number,
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  token_type: Schema.String,
});

const toTokenSet = (token: OAuth.OAuthToken): TwitchTokenSet => ({
  accessToken: token.accessToken,
  refreshToken: token.refreshToken ?? null,
  expiresAt: Date.now() + token.expiresIn * 1_000,
  scopes: token.scopes,
});

const oauthError = (operation: string, error: OAuth.OAuthError): TwitchError =>
  new TwitchError({
    operation,
    status: error.status ?? 0,
    message: error.message,
  });

const helixError = (
  operation: string,
  error: Helix.HelixError | Protocol.TokenProviderError | TwitchError,
): TwitchError =>
  error instanceof TwitchError
    ? error
    : error instanceof Helix.HelixError
      ? new TwitchError({
          operation,
          status: error.status ?? 0,
          message: error.message,
        })
      : new TwitchError({ operation, status: 0, message: error.message });

export const makeTwitchApi = (
  config: CloudConfigService,
): Effect.Effect<TwitchApiService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const clientId = config.twitchClientId;
    const clientSecret = Redacted.value(config.twitchClientSecret);
    const helixBaseUrl = `${config.twitchApiBaseUrl}/helix`;

    const oauth = yield* OAuth.make({
      clientId,
      clientSecret,
      authorizationUrl: `${config.twitchIdBaseUrl}/oauth2/authorize`,
      tokenUrl: `${config.twitchIdBaseUrl}/oauth2/token`,
      validateUrl: `${config.twitchIdBaseUrl}/oauth2/validate`,
      revokeUrl: `${config.twitchIdBaseUrl}/oauth2/revoke`,
    });

    const helixFor = (accessToken: string) =>
      Helix.make({ baseUrl: helixBaseUrl }).pipe(
        Effect.provide(Protocol.staticTokenProvider({ accessToken, clientId })),
        Effect.provideService(HttpClient.HttpClient, http),
      );

    const clientCredentials = Effect.gen(function* () {
      const request = HttpClientRequest.post(`${config.twitchIdBaseUrl}/oauth2/token`).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
        HttpClientRequest.bodyUrlParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
      );
      const response = yield* http.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new TwitchError({
              operation: "clientCredentials",
              status: 0,
              message: cause.message,
            }),
        ),
      );
      const body = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new TwitchError({
              operation: "clientCredentials",
              status: response.status,
              message: "Twitch returned an invalid token response",
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new TwitchError({
          operation: "clientCredentials",
          status: response.status,
          message: `Twitch returned HTTP ${response.status}`,
          body,
        });
      }
      const decoded = yield* Schema.decodeUnknownEffect(ClientCredentialsResponse)(body).pipe(
        Effect.mapError(
          (cause) =>
            new TwitchError({
              operation: "clientCredentials",
              status: response.status,
              message: "Twitch returned an invalid token response: " + cause.message,
            }),
        ),
      );
      return {
        accessToken: decoded.access_token,
        refreshToken: decoded.refresh_token ?? null,
        expiresAt: Date.now() + decoded.expires_in * 1_000,
        scopes: decoded.scope ?? [],
      } satisfies TwitchTokenSet;
    });

    return {
      authorizeUrl: (input) =>
        oauth.authorizeUrl({
          redirectUri: input.redirectUri,
          scopes: input.scopes,
          state: input.state,
          ...(input.forceVerify === undefined ? {} : { forceVerify: input.forceVerify }),
        }),

      exchangeAuthorizationCode: (code, redirectUri) =>
        oauth.exchangeCode({ code, redirectUri }).pipe(
          Effect.map(toTokenSet),
          Effect.mapError((error) => oauthError("exchangeAuthorizationCode", error)),
        ),

      refresh: (refreshToken) =>
        oauth.refreshToken(refreshToken).pipe(
          Effect.map(toTokenSet),
          Effect.mapError((error) => oauthError("refresh", error)),
        ),

      validateToken: (accessToken) =>
        oauth.validateToken(accessToken).pipe(
          Effect.map((validation) => ({
            userId: validation.userId,
            login: validation.login,
            scopes: validation.scopes,
            expiresAt: Date.now() + validation.expiresIn * 1_000,
          })),
          Effect.mapError((error) => oauthError("validateToken", error)),
        ),

      clientCredentials,

      getUser: (accessToken) =>
        Effect.gen(function* () {
          const helix = yield* helixFor(accessToken);
          const response = yield* helix.getUsers({});
          const user = response.data[0];
          if (user === undefined)
            return yield* new TwitchError({
              operation: "getUser",
              status: 200,
              message: "Twitch returned no user",
            });
          return {
            id: user.id,
            login: user.login,
            displayName: user.display_name,
            email: null,
          } satisfies TwitchUser;
        }).pipe(Effect.mapError((error) => helixError("getUser", error))),

      helix: (call) =>
        Effect.gen(function* () {
          const url = new URL(
            call.path.startsWith("/") ? call.path : `/${call.path}`,
            config.twitchApiBaseUrl,
          );
          for (const [key, value] of Object.entries(call.query ?? {})) {
            if (typeof value === "string") url.searchParams.append(key, value);
            else for (const item of value) url.searchParams.append(key, item);
          }
          let request = HttpClientRequest.make(call.method)(url.toString()).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${call.accessToken}`,
              "client-id": clientId,
            }),
          );
          if (call.body !== undefined) {
            request = HttpClientRequest.bodyJsonUnsafe(request, call.body).pipe(
              HttpClientRequest.setHeader("content-type", "application/json"),
            );
          }
          const response = yield* http.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new TwitchError({
                  operation: "helix",
                  status: 0,
                  message: cause.message,
                }),
            ),
          );
          const text = yield* response.text.pipe(
            Effect.catch(() =>
              Effect.succeed(""),
            ),
          );
          let body: unknown = null;
          if (text.length > 0) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
          return { status: response.status, body };
        }),

      createEventSubSubscription: (appAccessToken, input) =>
        Effect.gen(function* () {
          const helix = yield* helixFor(appAccessToken);
          const response = yield* helix.createEventSubSubscription({
            type: input.type,
            version: String(input.version),
            condition: input.condition,
            transport: {
              method: "webhook",
              callback: input.callback,
              secret: input.secret,
            },
          });
          const subscription = response.data[0];
          if (subscription === undefined)
            return yield* new TwitchError({
              operation: "createEventSubSubscription",
              status: 202,
              message: "Twitch did not return the created subscription",
            });
          return { id: subscription.id };
        }).pipe(Effect.mapError((error) => helixError("createEventSubSubscription", error))),

      deleteEventSubSubscription: (appAccessToken, id) =>
        Effect.gen(function* () {
          const helix = yield* helixFor(appAccessToken);
          yield* helix.deleteEventSubSubscription({ id });
        }).pipe(Effect.mapError((error) => helixError("deleteEventSubSubscription", error))),

      listEventSubSubscriptions: (appAccessToken) =>
        Effect.gen(function* () {
          const helix = yield* helixFor(appAccessToken);
          const subscriptions: Array<TwitchProviderSubscription> = [];
          let cursor: string | undefined;
          do {
            const page = yield* helix.getEventSubSubscriptions(
              cursor === undefined ? {} : { after: cursor },
            );
            subscriptions.push(
              ...page.data.map((subscription) => ({
                id: subscription.id,
                type: subscription.type,
                version: subscription.version,
                condition: subscription.condition,
                status: subscription.status,
                transport: {
                  method: subscription.transport?.method ?? "webhook",
                  callback:
                    subscription.transport?.method === "webhook"
                      ? subscription.transport.callback
                      : null,
                },
              })),
            );
            cursor = page.pagination?.cursor;
          } while (cursor !== undefined && cursor.length > 0);
          return subscriptions;
        }).pipe(Effect.mapError((error) => helixError("listEventSubSubscriptions", error))),
    } satisfies TwitchApiService;
  });

export const TwitchApiLive = Layer.effect(
  TwitchApi,
  Effect.gen(function* () {
    const config = yield* CloudConfig;
    return TwitchApi.of(yield* makeTwitchApi(config));
  }),
);
