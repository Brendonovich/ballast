import { Effect } from "effect";

import { makeCloudApp, type CloudAppService } from "../../src/app.ts";
import { makeCloudConfig, type CloudConfigService } from "../../src/config.ts";
import { hashMachineToken } from "../../src/secrets.ts";
import { makeTokenVault } from "../../src/secrets.ts";
import type {
  CloudStoreService,
  SubscriptionRow,
  TwitchAccountRow,
} from "../../src/store.ts";
import type { RelayGatewayService } from "../../src/relay/gateway.ts";
import type { IdentityProviderService } from "../../src/shares/oidc.ts";
import type { SharesApiRpc } from "@ballast/shares-api";
import { makeFakeTwitch, type FakeTwitch, type FakeTwitchOptions } from "./fake-twitch.ts";
import { makeMemoryStore } from "./memory-store.ts";

const tokenKey = (() => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
})();

export interface RelaySink {
  readonly events: Array<{ machineId: string; envelope: import("@ballast/cloud-protocol").EventEnvelope }>;
  readonly notifications: Array<{ machineId: string; message: import("@ballast/cloud-protocol").RelayServerMessage }>;
  readonly webhooks: Array<{
    machineId: string;
    delivery: import("@ballast/cloud-protocol").WebhookRelayDelivery;
    policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" };
  }>;
}

export interface TestApp {
  readonly app: CloudAppService;
  readonly config: CloudConfigService;
  readonly store: CloudStoreService;
  readonly twitch: FakeTwitch;
  readonly relay: RelaySink;
  readonly seedAccount: (input: {
    readonly userId?: string;
    readonly twitchUserId?: string;
    readonly login?: string;
    readonly displayName?: string;
    readonly accessToken?: string;
    readonly refreshToken?: string;
    readonly scopes?: ReadonlyArray<string>;
  }) => Promise<{ account: TwitchAccountRow; webhookSecret: string }>;
  readonly seedMachine: (
    userId: string,
    name?: string,
  ) => Promise<{ machineId: string; token: string }>;
  readonly seedSubscription: (
    account: TwitchAccountRow,
    machineId: string,
    input?: {
      readonly providerSubscriptionId?: string;
      readonly type?: string;
      readonly condition?: Readonly<Record<string, string>>;
      readonly onStale?: "drop" | "deliver";
      readonly maxAgeMs?: number;
    },
  ) => Promise<SubscriptionRow>;
  readonly request: (input: {
    readonly method: string;
    readonly path: string;
    /** Defaults to the cloud's public origin; set it to exercise host changes. */
    readonly origin?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly rawBody?: string;
  }) => Promise<{ status: number; headers?: Readonly<Record<string, string>>; body?: string }>;
}

export const makeTestApp = async (options: {
  readonly relay?: RelayGatewayService;
  readonly identity?: IdentityProviderService;
  readonly shares?: SharesApiRpc;
  readonly twitch?: FakeTwitchOptions;
  readonly publicOrigin?: string;
} = {}): Promise<TestApp> => {
  const config = makeCloudConfig({
    publicOrigin: options.publicOrigin ?? "http://localhost:1338",
    twitchClientId: "test-client-id",
    twitchClientSecret: "test-client-secret",
    tokenKey,
    tokenPepper: "test-pepper",
    defaultScopes: ["user:read:email", "channel:read:redemptions"],
    twitchIdBaseUrl: "http://twitch.test",
    twitchApiBaseUrl: "http://twitch.test",
  });
  const store = makeMemoryStore();
  const vault = await Effect.runPromise(makeTokenVault(config));
  const twitch = makeFakeTwitch(options.twitch);
  const relay: RelaySink = { events: [], notifications: [], webhooks: [] };
  const relayGateway: RelayGatewayService = options.relay ?? {
    enqueueEvent: (machineId, envelope) =>
      Effect.sync(() => {
        relay.events.push({ machineId, envelope });
      }),
    notify: (machineId, message) =>
      Effect.sync(() => {
        relay.notifications.push({ machineId, message });
      }),
    enqueueWebhook: (machineId, delivery, policy) =>
      Effect.sync(() => {
        relay.webhooks.push({ machineId, delivery, policy });
      }),
  };
  const app = await Effect.runPromise(
    makeCloudApp({
      config,
      store,
      vault,
      twitch: twitch.service,
      relay: relayGateway,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.shares === undefined ? {} : { shares: options.shares }),
    }),
  );

  const seedAccount: TestApp["seedAccount"] = async (input) => {
    const userId = input.userId ?? "12345";
    const twitchUserId = input.twitchUserId ?? "12345";
    const now = Date.now();
    await Effect.runPromise(
      store.upsertUser({
        id: userId,
        login: input.login ?? "streamer",
        displayName: input.displayName ?? "Streamer",
        email: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const webhookSecret = "event-sub-secret";
    const account: TwitchAccountRow = {
      id: `account-${userId}-${twitchUserId}`,
      userId,
      twitchUserId,
      login: input.login ?? "streamer",
      displayName: input.displayName ?? "Streamer",
      scopes: input.scopes ?? ["user:read:email", "channel:read:redemptions"],
      secrets: {
        refreshToken: await Effect.runPromise(vault.seal(input.refreshToken ?? "refresh-token-1")),
        accessToken: await Effect.runPromise(vault.seal(input.accessToken ?? "access-token-1")),
        accessTokenExpiresAt: now + 3_600_000,
        webhookSecret: await Effect.runPromise(vault.seal(webhookSecret)),
      },
      machineId: null,
      needsReauth: false,
      refreshLock: null,
      refreshLockUntil: 0,
      createdAt: now,
      updatedAt: now,
    };
    await Effect.runPromise(store.upsertTwitchAccount(account));
    return { account, webhookSecret };
  };

  const seedMachine: TestApp["seedMachine"] = async (userId, name = "Test machine") => {
    const machineId = `m_${crypto.randomUUID()}`;
    const token = `blst_m_${crypto.randomUUID()}`;
    const now = Date.now();
    await Effect.runPromise(
      store.insertMachine({
        id: machineId,
        userId,
        name,
        tokenHash: await hashMachineToken(config.tokenPepper, token),
        createdAt: now,
        lastSeenAt: now,
      }),
    );
    return { machineId, token };
  };

  const seedSubscription: TestApp["seedSubscription"] = async (account, machineId, input) => {
    const now = Date.now();
    const row: SubscriptionRow = {
      id: crypto.randomUUID(),
      accountId: account.id,
      machineId,
      type: input?.type ?? "channel.channel_points_custom_reward_redemption.add",
      version: 1,
      condition: input?.condition ?? { broadcaster_user_id: account.twitchUserId },
      cost: 1,
      providerSubscriptionId: input?.providerSubscriptionId ?? crypto.randomUUID(),
      status: "enabled",
      onStale: input?.onStale ?? "drop",
      maxAgeMs: input?.maxAgeMs ?? 60_000,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await Effect.runPromise(store.upsertSubscription(row));
    await Effect.runPromise(
      store.upsertSubscriptionOwner({
        subscriptionId: row.id,
        owner: "default",
        onStale: row.onStale,
        maxAgeMs: row.maxAgeMs,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return row;
  };

  const request: TestApp["request"] = async (input) => {
    const body =
      input.rawBody !== undefined
        ? new TextEncoder().encode(input.rawBody)
        : input.body === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(input.body));
    const response = await Effect.runPromise(
      app.fetch({
        method: input.method,
        url: `${input.origin ?? config.publicOrigin}${input.path}`,
        headers: Object.fromEntries(
          Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        body,
      }),
    );
    return {
      status: response.status,
      ...(response.headers === undefined ? {} : { headers: response.headers }),
      ...(response.body === undefined
        ? {}
        : { body: typeof response.body === "string" ? response.body : new TextDecoder().decode(response.body) }),
    };
  };

  return {
    app,
    config,
    store,
    twitch,
    relay,
    seedAccount,
    seedMachine,
    seedSubscription,
    request,
  };
};
