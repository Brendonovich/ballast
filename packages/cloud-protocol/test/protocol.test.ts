import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  EventEnvelope,
  RelayClientMessage,
  RelayServerMessage,
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
