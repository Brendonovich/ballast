import type * as Effect from "effect/Effect";
import type * as Twitch from "@ballast/module-twitch";

import type { TwitchTransportError } from "./errors.ts";

export interface TwitchIdentity {
  readonly userId: string;
  readonly login: string;
  readonly displayName?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly clientId?: string;
}

/**
 * One EventSub subscription the transport should keep alive. `type` is the
 * Twitch subscription type; `topic` is the Ballast topic key sent on the bus.
 */
export interface TwitchSubscriptionSpec {
  readonly type: Twitch.EventSub.SubscriptionType;
  readonly version: number;
  readonly condition: Readonly<Record<string, string>>;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
}

/**
 * The per-account contract from decision 0002. The script-facing API and the
 * event bus are identical in both modes; only the implementation of tokens,
 * subscriptions and Helix requests changes.
 */
export interface TwitchTransport {
  readonly mode: "local-app" | "cloud";
  readonly slot: string;
  /** Cloud connection id, or `local:<slot>` for the user's own app. */
  readonly connectionId: string;
  readonly getToken: Effect.Effect<TwitchIdentity, TwitchTransportError>;
  /**
   * Make sure exactly these EventSub subscriptions exist. Called on apply and
   * after a hot reload; the local transport starts its WebSocket session.
   */
  readonly subscribe: (
    specs: ReadonlyArray<TwitchSubscriptionSpec>,
  ) => Effect.Effect<void, TwitchTransportError>;
  /** Execute a Helix request by its manifest name (`sendChatMessage`). */
  readonly request: (
    name: Twitch.Helix.RequestName,
    input: unknown,
  ) => Effect.Effect<unknown, TwitchTransportError>;
}

export const subscriptionKey = (spec: TwitchSubscriptionSpec): string =>
  JSON.stringify([
    spec.type,
    spec.version,
    Object.keys(spec.condition)
      .sort()
      .map((key) => [key, spec.condition[key]]),
  ]);

export const subscriptionsKey = (specs: ReadonlyArray<TwitchSubscriptionSpec>): string =>
  JSON.stringify(specs.map(subscriptionKey).sort());

export const busTopic = (slot: string, topic: string): string =>
  "twitch/" + slot + "/" + topic;
