import { Config, Context, Effect, Layer, Redacted } from "effect";

import { DEFAULT_RETENTION_MS, DEFAULT_TWITCH_MAX_SUBSCRIPTION_COST } from "@ballast/cloud-protocol";

export interface CloudConfigService {
  readonly publicOrigin: string;
  readonly twitchClientId: string;
  readonly twitchClientSecret: Redacted.Redacted<string>;
  /** AES-256-GCM key for refresh tokens and webhook secrets. */
  readonly tokenKey: Uint8Array;
  /** Mixed into machine-token hashes so a leaked database cannot be replayed directly. */
  readonly tokenPepper: string;
  readonly defaultScopes: ReadonlyArray<string>;
  readonly maxSubscriptionCost: number;
  readonly webhookTimestampToleranceMs: number;
  readonly retentionMs: number;
  readonly twitchIdBaseUrl: string;
  readonly twitchApiBaseUrl: string;
}

export class CloudConfig extends Context.Service<CloudConfig, CloudConfigService>()(
  "Ballast/CloudConfig",
) {}

export const DEV_PUBLIC_ORIGIN = "http://localhost:1338";

export const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const parseKey = (value: string): Uint8Array => {
  const bytes = value.length === 64 && /^[0-9a-f]+$/i.test(value)
    ? Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
    : decodeBase64Url(value);
  if (bytes.byteLength !== 32)
    throw new Error("BALLAST_TOKEN_KEY must be 32 bytes, base64url or 64 hex characters");
  return bytes;
};

export const makeCloudConfig = (values: {
  readonly publicOrigin?: string;
  readonly twitchClientId: string;
  readonly twitchClientSecret: string;
  readonly tokenKey: string;
  readonly tokenPepper: string;
  readonly defaultScopes?: ReadonlyArray<string>;
  readonly maxSubscriptionCost?: number;
  readonly webhookTimestampToleranceMs?: number;
  readonly retentionMs?: number;
  readonly twitchIdBaseUrl?: string;
  readonly twitchApiBaseUrl?: string;
}): CloudConfigService => ({
  publicOrigin: (values.publicOrigin ?? DEV_PUBLIC_ORIGIN).replace(/\/$/, ""),
  twitchClientId: values.twitchClientId,
  twitchClientSecret: Redacted.make(values.twitchClientSecret),
  tokenKey: parseKey(values.tokenKey),
  tokenPepper: values.tokenPepper,
  defaultScopes: values.defaultScopes ?? ["user:read:email", "channel:read:redemptions"],
  maxSubscriptionCost: values.maxSubscriptionCost ?? DEFAULT_TWITCH_MAX_SUBSCRIPTION_COST,
  webhookTimestampToleranceMs: values.webhookTimestampToleranceMs ?? 10 * 60_000,
  retentionMs: values.retentionMs ?? DEFAULT_RETENTION_MS,
  twitchIdBaseUrl: (values.twitchIdBaseUrl ?? "https://id.twitch.tv").replace(/\/$/, ""),
  twitchApiBaseUrl: (values.twitchApiBaseUrl ?? "https://api.twitch.tv").replace(/\/$/, ""),
});

/**
 * Reads the Worker's bound environment. Alchemy captures each `Config` at
 * plan time and reads it back from the Worker's env at runtime. A Worker's
 * Effect init can yield this directly so the bindings are registered without
 * a separate `env` prop.
 */
export const loadCloudConfig = Effect.gen(function* () {
  const values = yield* Config.all({
    publicOrigin: Config.String("BALLAST_PUBLIC_ORIGIN").pipe(
      Config.withDefault(DEV_PUBLIC_ORIGIN),
    ),
    twitchClientId: Config.String("TWITCH_CLIENT_ID"),
    twitchClientSecret: Config.Redacted("TWITCH_CLIENT_SECRET"),
    tokenKey: Config.Redacted("BALLAST_TOKEN_KEY"),
    tokenPepper: Config.String("BALLAST_TOKEN_PEPPER"),
    maxSubscriptionCost: Config.Number("BALLAST_TWITCH_MAX_SUBSCRIPTION_COST").pipe(
      Config.withDefault(DEFAULT_TWITCH_MAX_SUBSCRIPTION_COST),
    ),
    twitchIdBaseUrl: Config.String("TWITCH_ID_BASE_URL").pipe(
      Config.withDefault("https://id.twitch.tv"),
    ),
    twitchApiBaseUrl: Config.String("TWITCH_API_BASE_URL").pipe(
      Config.withDefault("https://api.twitch.tv"),
    ),
  });
  return makeCloudConfig({
    publicOrigin: values.publicOrigin,
    twitchClientId: values.twitchClientId,
    twitchClientSecret: Redacted.value(values.twitchClientSecret),
    tokenKey: Redacted.value(values.tokenKey),
    tokenPepper: values.tokenPepper,
    maxSubscriptionCost: values.maxSubscriptionCost,
    twitchIdBaseUrl: values.twitchIdBaseUrl,
    twitchApiBaseUrl: values.twitchApiBaseUrl,
  });
});

export const CloudConfigLive = Layer.effect(
  CloudConfig,
  Effect.map(loadCloudConfig, (config) => CloudConfig.of(config)),
);
