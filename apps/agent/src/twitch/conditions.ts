import * as Effect from "effect/Effect";
import type { Manifest, TopicCondition } from "@ballast/core";
import * as Twitch from "@ballast/module-twitch";

import { transportError } from "./errors.ts";
import type { TwitchTransportError } from "./errors.ts";
import type { TwitchSubscriptionSpec } from "./transport.ts";

export const TWITCH_TOPIC_PREFIX = "twitch/";

export const twitchTopicType = (topic: string): string | undefined =>
  topic.startsWith(TWITCH_TOPIC_PREFIX)
    ? topic.slice(TWITCH_TOPIC_PREFIX.length)
    : undefined;

/** Every connection slot a topic condition refers to via `{ slot }`. */
export const conditionSlots = (manifest: Manifest): ReadonlySet<string> => {
  const slots = new Set<string>();
  for (const topic of manifest.topics) {
    if (topic.integration !== "twitch" || topic.condition === undefined) continue;
    for (const value of Object.values(topic.condition)) {
      if (typeof value === "object") slots.add(value.slot);
    }
  }
  return slots;
};

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

/** Scopes the manifest needs from one Twitch connection slot. */
export const requiredScopes = (
  manifest: Manifest,
  slot: string,
): ReadonlyArray<string> =>
  unique([
    ...manifest.topics
      .filter((topic) => topic.integration === "twitch" && topic.slot === slot)
      .flatMap((topic) => topic.scopes),
    ...manifest.requests
      .filter((request) => request.integration === "twitch" && request.slot === slot)
      .flatMap((request) => request.scopes),
  ]);

export const missingScopes = (
  required: ReadonlyArray<string>,
  granted: ReadonlyArray<string>,
): ReadonlyArray<string> => required.filter((scope) => !granted.includes(scope));

const resolveCondition = (
  condition: TopicCondition,
  accountSlots: ReadonlyMap<string, string>,
): Effect.Effect<Readonly<Record<string, string>>, TwitchTransportError> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(condition)) {
      if (typeof value === "string") {
        resolved[key] = value;
        continue;
      }
      const userId = accountSlots.get(value.slot);
      if (userId === undefined) {
        return yield* transportError(
          "Twitch topic condition refers to account slot '" +
            value.slot +
            "', but that slot has no account identity.",
        );
      }
      resolved[key] = userId;
    }
    return resolved;
  });

/**
 * Turn the manifest's Twitch topics for one slot into concrete EventSub
 * subscriptions. `{ slot }` condition values are replaced with the slot's
 * user id; planning never has that id, which is why it is deferred to here.
 */
export const subscriptionSpecs = (
  manifest: Manifest,
  slot: string,
  accountSlots: ReadonlyMap<string, string>,
): Effect.Effect<ReadonlyArray<TwitchSubscriptionSpec>, TwitchTransportError> =>
  Effect.gen(function* () {
    const specs: Array<TwitchSubscriptionSpec> = [];

    for (const topic of manifest.topics) {
      if (topic.integration !== "twitch" || topic.slot !== slot) continue;
      const type = twitchTopicType(topic.topic);
      if (type === undefined || !Twitch.EventSub.isSubscriptionType(type)) {
        return yield* transportError(
          "Unknown Twitch EventSub subscription type in topic '" + topic.topic + "'",
        );
      }

      const ownUserId = accountSlots.get(slot);
      if (ownUserId === undefined) {
        return yield* transportError(
          "Twitch slot '" + slot + "' has no account identity to build its subscription.",
        );
      }

      const resolved =
        topic.condition === undefined
          ? { broadcaster_user_id: ownUserId }
          : yield* resolveCondition(topic.condition, accountSlots);

      specs.push({
        type,
        version: Twitch.EventSub.subscriptions[type].version,
        condition: resolved,
        onStale: topic.onStale,
        maxAgeMs: topic.maxAgeMs,
      });
    }

    return specs;
  });
