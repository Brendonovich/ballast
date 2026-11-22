import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ErrorTag,
  EventEnvelope,
  ReconcileSubscriptionsRequest,
  RelayClientMessage,
  RelayServerMessage,
  TwitchConnection,
  TwitchSubscription,
  conditionKey,
  decodeEventSubDelivery,
  encodeRelayServerMessage,
  subscriptionKey,
  twitchSubscriptionCost,
  twitchTopic,
} from "../src/index.ts";

describe("cloud protocol", () => {
  it("round-trips an event envelope", () => {
    const envelope = {
      id: "twitch:msg-1",
      integration: "twitch",
      topic: "twitch/channel.cheer",
      connectionId: "account-1",
      occurredAt: 1_000,
      receivedAt: 1_001,
      payload: { bits: 100 },
      onStale: "drop" as const,
      maxAgeMs: 60_000,
    };
    const encoded = Schema.encodeSync(EventEnvelope)(envelope);
    expect(Schema.decodeUnknownSync(EventEnvelope)(encoded)).toEqual(envelope);
  });

  it("round-trips relay messages", () => {
    const message = {
      _tag: "event" as const,
      seq: 3,
      envelope: {
        id: "twitch:msg-1",
        integration: "twitch",
        topic: "twitch/channel.cheer",
        connectionId: "account-1",
        occurredAt: 1_000,
        receivedAt: 1_001,
        payload: { bits: 100 },
        onStale: "deliver" as const,
        maxAgeMs: 60_000,
      },
      stale: true,
    };
    const encoded = encodeRelayServerMessage(message);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(RelayServerMessage))(encoded)).toEqual(
      message,
    );
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(RelayClientMessage))(
        JSON.stringify({ _tag: "ack", seqs: [3] }),
      ),
    ).toEqual({ _tag: "ack", seqs: [3] });
  });

  it("canonicalises conditions and computes Twitch subscription keys and costs", () => {
    expect(
      conditionKey({ broadcaster_user_id: "1", moderator_user_id: "2" }),
    ).toBe(conditionKey({ moderator_user_id: "2", broadcaster_user_id: "1" }));
    expect(
      subscriptionKey({
        type: "channel.cheer",
        version: 1,
        condition: { broadcaster_user_id: "1" },
      }),
    ).toBe(
      subscriptionKey({
        type: "channel.cheer",
        version: 1,
        condition: { broadcaster_user_id: "1" },
      }),
    );
    expect(twitchSubscriptionCost("channel.cheer")).toBe(1);
    expect(twitchSubscriptionCost("channel.update")).toBe(2);
    expect(twitchTopic("channel.cheer")).toBe("twitch/channel.cheer");
  });

  it("accepts owners, needsReauth and the rate_limited tag additively", () => {
    const connection = {
      id: "account-1",
      twitchUserId: "12345",
      login: "streamer",
      displayName: "Streamer",
      scopes: ["user:read:chat"],
      machineId: null,
      needsReauth: true,
      createdAt: 1_000,
    };
    expect(Schema.decodeUnknownSync(TwitchConnection)(connection)).toMatchObject({
      needsReauth: true,
    });
    const { needsReauth: _needsReauth, ...legacyConnection } = connection;
    expect(Schema.decodeUnknownSync(TwitchConnection)(legacyConnection)).toMatchObject({
      login: "streamer",
    });
    expect(
      Schema.decodeUnknownSync(ReconcileSubscriptionsRequest)({
        connectionId: "account-1",
        owner: "project-a",
        subscriptions: [],
      }).owner,
    ).toBe("project-a");
    expect(
      Schema.decodeUnknownSync(ReconcileSubscriptionsRequest)({
        connectionId: "account-1",
        subscriptions: [],
      }).owner,
    ).toBeUndefined();
    expect(Schema.decodeUnknownSync(ErrorTag)("rate_limited")).toBe("rate_limited");
    expect(
      Schema.decodeUnknownSync(TwitchSubscription)({
        id: "sub-1",
        providerSubscriptionId: null,
        type: "channel.cheer",
        version: 1,
        condition: { broadcaster_user_id: "1" },
        status: "enabled",
        cost: 1,
        owners: ["project-a", "project-b"],
        createdAt: 1,
        updatedAt: 2,
      }).owners,
    ).toEqual(["project-a", "project-b"]);
  });

  it("decodes a Twitch EventSub delivery", () => {
    const delivery = decodeEventSubDelivery(
      JSON.stringify({
        challenge: "challenge-token",
        subscription: {
          id: "sub-1",
          status: "webhook_callback_verification_pending",
          type: "channel.cheer",
          version: "1",
          condition: { broadcaster_user_id: "1" },
        },
      }),
    );
    expect(delivery.challenge).toBe("challenge-token");
    expect(delivery.subscription.id).toBe("sub-1");
  });
});
