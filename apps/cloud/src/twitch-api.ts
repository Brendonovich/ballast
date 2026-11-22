import { Helix, OAuth, Protocol } from "@ballast/module-twitch";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { HttpClient } from "effect/http";

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
  /** Present only when the token has `user:read:email`. */
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

    const clientCredentials = oauth.clientCredentials.pipe(
      Effect.map(toTokenSet),
      Effect.mapError((error) => oauthError("clientCredentials", error)),
    );

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
            email: user.email ?? null,
          } satisfies TwitchUser;
        }).pipe(Effect.mapError((error) => helixError("getUser", error))),

      helix: (call) =>
        Effect.gen(function* () {
          const client = yield* Helix.make({ baseUrl: config.twitchApiBaseUrl }).pipe(
            Effect.provide(
              Protocol.staticTokenProvider({
                accessToken: call.accessToken,
                clientId,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          );
          return yield* client.requestRaw({
            method: call.method,
            path: call.path,
            ...(call.query === undefined ? {} : { query: call.query }),
            ...(call.body === undefined ? {} : { body: call.body }),
          });
        }).pipe(Effect.mapError((error) => helixError("helix", error))),

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
