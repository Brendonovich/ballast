import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

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
  readonly exchangeAuthorizationCode: (
    code: string,
    redirectUri: string,
  ) => Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly refresh: (refreshToken: string) => Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly clientCredentials: Effect.Effect<TwitchTokenSet, TwitchError>;
  readonly getUser: (accessToken: string) => Effect.Effect<TwitchUser, TwitchError>;
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

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expires_in: Schema.Number,
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  token_type: Schema.String,
});

const UserResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      login: Schema.String,
      display_name: Schema.String,
      email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const SubscriptionResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      version: Schema.String,
      condition: Schema.Record(Schema.String, Schema.String),
      status: Schema.String,
      transport: Schema.Struct({
        method: Schema.String,
        callback: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
  ),
  pagination: Schema.optionalKey(Schema.Struct({ cursor: Schema.optionalKey(Schema.String) })),
  total: Schema.optionalKey(Schema.Number),
});

const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const request = (
  operation: string,
  url: string,
  init: RequestInit,
): Effect.Effect<{ status: number; body: unknown }, TwitchError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      return { status: response.status, body: await readBody(response) };
    },
    catch: (cause) =>
      new TwitchError({
        operation,
        status: 0,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const expectStatus = (
  operation: string,
  response: { status: number; body: unknown },
  expected: number,
): Effect.Effect<{ status: number; body: unknown }, TwitchError> =>
  response.status === expected
    ? Effect.succeed(response)
    : Effect.fail(
        new TwitchError({
          operation,
          status: response.status,
          message: `Twitch returned HTTP ${response.status}`,
          body: response.body,
        }),
      );

const decode = <A, I>(
  operation: string,
  schema: Schema.Codec<A, I>,
  body: unknown,
): Effect.Effect<A, TwitchError> =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) =>
        new TwitchError({
          operation,
          status: 0,
          message: "Twitch returned an invalid response",
          body: String(cause),
        }),
    ),
  );

const form = (values: Readonly<Record<string, string>>): string =>
  new URLSearchParams(values).toString();

export const makeTwitchApi = (config: CloudConfigService): TwitchApiService => {
  const clientId = config.twitchClientId;
  const clientSecret = Redacted.value(config.twitchClientSecret);

  const tokenRequest = (operation: string, fields: Record<string, string>) =>
    request(operation, `${config.twitchIdBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(fields),
    }).pipe(
      Effect.flatMap((response) => expectStatus(operation, response, 200)),
      Effect.flatMap((response) => decode(operation, TokenResponse, response.body)),
      Effect.map((tokens) => ({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: Date.now() + tokens.expires_in * 1_000,
        scopes: tokens.scope ?? [],
      })),
    );

  const helixHeaders = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    "client-id": clientId,
  });

  const buildHelixUrl = (path: string, query?: HelixCall["query"]) => {
    const url = new URL(path, config.twitchApiBaseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else if (typeof value === "string") url.searchParams.append(key, value);
    }
    return url.toString();
  };

  return {
    exchangeAuthorizationCode: (code, redirectUri) =>
      tokenRequest("exchangeAuthorizationCode", {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),

    refresh: (refreshToken) =>
      tokenRequest("refresh", {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),

    clientCredentials: tokenRequest("clientCredentials", {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),

    getUser: (accessToken) =>
      request("getUser", `${config.twitchApiBaseUrl}/helix/users`, {
        method: "GET",
        headers: helixHeaders(accessToken),
      }).pipe(
        Effect.flatMap((response) => expectStatus("getUser", response, 200)),
        Effect.flatMap((response) => decode("getUser", UserResponse, response.body)),
        Effect.flatMap((response) => {
          const user = response.data[0];
          return user === undefined
            ? Effect.fail(
                new TwitchError({
                  operation: "getUser",
                  status: 200,
                  message: "Twitch returned no user",
                }),
              )
            : Effect.succeed({
                id: user.id,
                login: user.login,
                displayName: user.display_name,
                email: user.email ?? null,
              });
        }),
      ),

    helix: (call) =>
      request("helix", buildHelixUrl(call.path, call.query), {
        method: call.method,
        headers: {
          ...helixHeaders(call.accessToken),
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      }),

    createEventSubSubscription: (appAccessToken, input) =>
      request("createEventSubSubscription", `${config.twitchApiBaseUrl}/helix/eventsub/subscriptions`, {
        method: "POST",
        headers: {
          ...helixHeaders(appAccessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: input.type,
          version: String(input.version),
          condition: input.condition,
          transport: {
            method: "webhook",
            callback: input.callback,
            secret: input.secret,
          },
        }),
      }).pipe(
        Effect.flatMap((response) => expectStatus("createEventSubSubscription", response, 202)),
        Effect.flatMap((response) => decode("createEventSubSubscription", SubscriptionResponse, response.body)),
        Effect.flatMap((response) => {
          const subscription = response.data[0];
          return subscription === undefined
            ? Effect.fail(
                new TwitchError({
                  operation: "createEventSubSubscription",
                  status: 202,
                  message: "Twitch did not return the created subscription",
                }),
              )
            : Effect.succeed({ id: subscription.id });
        }),
      ),

    deleteEventSubSubscription: (appAccessToken, id) =>
      request(
        "deleteEventSubSubscription",
        `${config.twitchApiBaseUrl}/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: helixHeaders(appAccessToken),
        },
      ).pipe(
        Effect.flatMap((response) => expectStatus("deleteEventSubSubscription", response, 204)),
        Effect.asVoid,
      ),

    listEventSubSubscriptions: (appAccessToken) =>
      Effect.gen(function* () {
        const subscriptions: Array<TwitchProviderSubscription> = [];
        let cursor: string | undefined;
        do {
          const query = cursor === undefined ? "" : `?after=${encodeURIComponent(cursor)}`;
          const response = yield* request(
            "listEventSubSubscriptions",
            `${config.twitchApiBaseUrl}/helix/eventsub/subscriptions${query}`,
            { method: "GET", headers: helixHeaders(appAccessToken) },
          ).pipe(Effect.flatMap((value) => expectStatus("listEventSubSubscriptions", value, 200)));
          const decoded = yield* decode(
            "listEventSubSubscriptions",
            SubscriptionResponse,
            response.body,
          );
          subscriptions.push(
            ...decoded.data.map((subscription) => ({
              id: subscription.id,
              type: subscription.type,
              version: subscription.version,
              condition: subscription.condition,
              status: subscription.status,
              transport: {
                method: subscription.transport.method,
                callback: subscription.transport.callback ?? null,
              },
            })),
          );
          cursor = decoded.pagination?.cursor;
        } while (cursor !== undefined && cursor.length > 0);
        return subscriptions;
      }),
  };
};

export const TwitchApiLive = Layer.effect(
  TwitchApi,
  Effect.gen(function* () {
    const config = yield* CloudConfig;
    return TwitchApi.of(makeTwitchApi(config));
  }),
);
