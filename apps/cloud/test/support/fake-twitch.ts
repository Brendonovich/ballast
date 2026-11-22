import { Effect } from "effect";

import type {
  CreateEventSubSubscription,
  HelixCall,
  TwitchApiService,
  TwitchProviderSubscription,
  TwitchTokenSet,
  TwitchUser,
} from "../../src/twitch-api.ts";

export interface FakeTwitchOptions {
  readonly user?: TwitchUser;
  readonly tokens?: Partial<TwitchTokenSet>;
  readonly helix?: (call: HelixCall) => { readonly status: number; readonly body: unknown };
}

export interface FakeTwitch {
  readonly service: TwitchApiService;
  readonly createdSubscriptions: Array<CreateEventSubSubscription & { id: string }>;
  readonly deletedSubscriptions: string[];
  readonly helixCalls: HelixCall[];
  readonly refreshCalls: string[];
  readonly providerSubscriptions: () => ReadonlyArray<TwitchProviderSubscription>;
}

export const makeFakeTwitch = (options: FakeTwitchOptions = {}): FakeTwitch => {
  const user: TwitchUser = options.user ?? {
    id: "12345",
    login: "streamer",
    displayName: "Streamer",
    email: "streamer@example.com",
  };
  const tokens: TwitchTokenSet = {
    accessToken: options.tokens?.accessToken ?? "access-token-1",
    refreshToken: options.tokens?.refreshToken ?? "refresh-token-1",
    expiresAt: options.tokens?.expiresAt ?? Date.now() + 3_600_000,
    scopes: options.tokens?.scopes ?? ["user:read:email", "channel:read:redemptions"],
  };
  const created: Array<CreateEventSubSubscription & { id: string }> = [];
  const deleted: string[] = [];
  const helixCalls: HelixCall[] = [];
  const refreshCalls: string[] = [];
  let providerSubscriptions: Array<TwitchProviderSubscription> = [];
  let nextSubscription = 1;

  const service: TwitchApiService = {
    exchangeAuthorizationCode: () => Effect.succeed(tokens),
    refresh: (refreshToken) =>
      Effect.sync(() => {
        refreshCalls.push(refreshToken);
        return { ...tokens, accessToken: `refreshed-${refreshCalls.length}` };
      }),
    clientCredentials: Effect.succeed({
      accessToken: "app-access-token",
      refreshToken: null,
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
    }),
    getUser: () => Effect.succeed(user),
    helix: (call) =>
      Effect.sync(() => {
        helixCalls.push(call);
        return options.helix?.(call) ?? { status: 200, body: { data: [] } };
      }),
    createEventSubSubscription: (_token, input) =>
      Effect.sync(() => {
        const id = `sub_${nextSubscription++}`;
        created.push({ ...input, id });
        providerSubscriptions = [
          ...providerSubscriptions,
          {
            id,
            type: input.type,
            version: String(input.version),
            condition: input.condition,
            status: "enabled",
            transport: { method: "webhook", callback: input.callback },
          },
        ];
        return { id };
      }),
    deleteEventSubSubscription: (_token, id) =>
      Effect.sync(() => {
        deleted.push(id);
        providerSubscriptions = providerSubscriptions.filter((subscription) => subscription.id !== id);
      }),
    listEventSubSubscriptions: () => Effect.sync(() => providerSubscriptions),
  };

  return {
    service,
    createdSubscriptions: created,
    deletedSubscriptions: deleted,
    helixCalls,
    refreshCalls,
    providerSubscriptions: () => providerSubscriptions,
  };
};
