import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import {
  computeEventSubSignature,
  verifyEventSubSignature,
} from "../src/eventsub.ts";
import { makeTestApp } from "./support/test-app.ts";

const json = (body: string | undefined) =>
  body === undefined ? undefined : JSON.parse(body) as unknown;

describe("EventSub signature verification", () => {
  it("accepts Twitch's documented HMAC scheme and rejects tampering", async () => {
    const messageId = "msg-1";
    const timestamp = "2026-11-22T10:00:00.000Z";
    const body = new TextEncoder().encode('{"hello":"world"}');
    const signature = await Effect.runPromise(
      computeEventSubSignature("secret", messageId, timestamp, body),
    );
    expect(
      await Effect.runPromise(
        verifyEventSubSignature("secret", messageId, timestamp, body, signature),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        verifyEventSubSignature("secret", messageId, timestamp, new TextEncoder().encode("{}"), signature),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        verifyEventSubSignature("other", messageId, timestamp, body, signature),
      ),
    ).toBe(false);
  });
});

describe("OAuth and machine API", () => {
  it("runs OAuth, stores sealed tokens, pairs a machine and serves tokens and Helix", async () => {
    const test = await makeTestApp();
    const start = await test.request({
      method: "GET",
      path: "/oauth/twitch/start?scopes=user:read:email,channel:read:redemptions",
    });
    expect(start.status).toBe(302);
    const location = start.headers?.location;
    expect(location).toBeDefined();
    const authorize = new URL(location ?? "");
    expect(authorize.origin + authorize.pathname).toBe("http://twitch.test/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
    const state = authorize.searchParams.get("state");
    expect(state).not.toBeNull();

    const callback = await test.request({
      method: "GET",
      path: `/oauth/twitch/callback?code=code-1&state=${state ?? ""}&format=json`,
    });
    expect(callback.status).toBe(200);
    const connected = json(callback.body) as {
      userId: string;
      accountId: string;
      pairingCode: string;
      login: string;
    };
    expect(connected.login).toBe("streamer");
    expect(connected.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const stored = await Effect.runPromise(test.store.findAccount(connected.accountId));
    expect(Option.isSome(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("refresh-token-1");
    expect(JSON.stringify(stored)).not.toContain("access-token-1");

    const claim = await test.request({
      method: "POST",
      path: "/api/pairing/claim",
      body: { code: connected.pairingCode, machineName: "Studio PC" },
    });
    expect(claim.status).toBe(200);
    const machine = json(claim.body) as { machineId: string; machineToken: string };
    expect(machine.machineId).toMatch(/^m_/);
    expect(machine.machineToken).toMatch(/^blst_m_/);

    const replay = await test.request({
      method: "POST",
      path: "/api/pairing/claim",
      body: { code: connected.pairingCode, machineName: "Second PC" },
    });
    expect(replay.status).toBe(404);

    const unauthorized = await test.request({
      method: "GET",
      path: "/api/connections",
    });
    expect(unauthorized.status).toBe(401);

    const connections = await test.request({
      method: "GET",
      path: "/api/connections",
      headers: { authorization: `Bearer ${machine.machineToken}` },
    });
    expect(connections.status).toBe(200);
    expect(json(connections.body)).toMatchObject({
      connections: [expect.objectContaining({ id: connected.accountId, login: "streamer" })],
    });

    const token = await test.request({
      method: "POST",
      path: "/api/tokens/twitch",
      headers: { authorization: `Bearer ${machine.machineToken}` },
      body: { connectionId: connected.accountId },
    });
    expect(token.status).toBe(200);
    expect(json(token.body)).toMatchObject({
      accessToken: "access-token-1",
      twitchUserId: "12345",
      login: "streamer",
    });

    const missingScope = await test.request({
      method: "POST",
      path: "/api/twitch/helix",
      headers: { authorization: `Bearer ${machine.machineToken}` },
      body: {
        connectionId: connected.accountId,
        method: "GET",
        path: "/helix/channels",
        scopes: ["channel:manage:broadcast"],
      },
    });
    expect(missingScope.status).toBe(403);
    expect(json(missingScope.body)).toMatchObject({
      error: { tag: "missing_scopes" },
    });

    const helix = await test.request({
      method: "POST",
      path: "/api/twitch/helix",
      headers: { authorization: `Bearer ${machine.machineToken}` },
      body: {
        connectionId: connected.accountId,
        method: "GET",
        path: "/helix/users",
        query: { login: "streamer" },
        scopes: ["user:read:email"],
      },
    });
    expect(helix.status).toBe(200);
    expect(test.twitch.helixCalls).toHaveLength(1);
    expect(test.twitch.helixCalls[0]?.accessToken).toBe("access-token-1");
    expect(json(helix.body)).toMatchObject({ status: 200, refreshed: false });
  });

  it("refreshes an expired access token before using it", async () => {
    const test = await makeTestApp();
    const { account } = await test.seedAccount({});
    // Expire the sealed access token, keeping the refresh token valid.
    const updated = await Effect.runPromise(test.store.findAccount(account.id));
    expect(Option.isSome(updated)).toBe(true);
    if (Option.isNone(updated)) return;
    const machine = await test.seedMachine(account.userId);
    await Effect.runPromise(
      test.store.updateAccountSecrets(
        account.id,
        { ...updated.value.secrets, accessTokenExpiresAt: 0 },
        Date.now(),
      ),
    );
    const token = await test.request({
      method: "POST",
      path: "/api/tokens/twitch",
      headers: { authorization: `Bearer ${machine.token}` },
      body: { connectionId: account.id },
    });
    expect(token.status).toBe(200);
    expect(json(token.body)).toMatchObject({ accessToken: "refreshed-1" });
    expect(test.twitch.refreshCalls).toEqual(["refresh-token-1"]);
  });
});

describe("EventSub webhook ingress", () => {
  const delivery = (
    accountId: string,
    subscriptionId: string,
    event: unknown = { id: "redemption-1", reward: { title: "Hydrate", cost: 100 } },
  ) => ({
    subscription: {
      id: subscriptionId,
      status: "enabled",
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: accountId },
    },
    event,
  });

  const post = async (
    test: Awaited<ReturnType<typeof makeTestApp>>,
    accountId: string,
    webhookSecret: string,
    options: {
      readonly messageId: string;
      readonly messageType: string;
      readonly payload: unknown;
      readonly timestamp?: string;
      readonly secret?: string;
    },
  ) => {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const body = JSON.stringify(options.payload);
    const signature = await Effect.runPromise(
      computeEventSubSignature(
        options.secret ?? webhookSecret,
        options.messageId,
        timestamp,
        new TextEncoder().encode(body),
      ),
    );
    return test.request({
      method: "POST",
      path: `/webhooks/twitch/eventsub/${accountId}`,
      headers: {
        "twitch-eventsub-message-id": options.messageId,
        "twitch-eventsub-message-timestamp": timestamp,
        "twitch-eventsub-message-signature": signature,
        "twitch-eventsub-message-type": options.messageType,
        "content-type": "application/json",
      },
      rawBody: body,
    });
  };

  it("answers the challenge, verifies, dedupes and relays notifications", async () => {
    const test = await makeTestApp();
    const { account, webhookSecret } = await test.seedAccount({});
    const machine = await test.seedMachine(account.userId);
    await test.seedSubscription(account, machine.machineId, { providerSubscriptionId: "sub-1" });

    const challenge = await post(test, account.id, webhookSecret, {
      messageId: "challenge-1",
      messageType: "webhook_callback_verification",
      payload: { ...delivery(account.twitchUserId, "sub-1"), challenge: "challenge-token" },
    });
    expect(challenge.status).toBe(200);
    expect(challenge.body).toBe("challenge-token");

    const notification = await post(test, account.id, webhookSecret, {
      messageId: "msg-1",
      messageType: "notification",
      payload: delivery(account.twitchUserId, "sub-1"),
    });
    expect(notification.status).toBe(204);
    expect(test.relay.events).toHaveLength(1);
    expect(test.relay.events[0]?.machineId).toBe(machine.machineId);
    expect(test.relay.events[0]?.envelope).toMatchObject({
      id: "twitch:msg-1",
      integration: "twitch",
      topic: "twitch/channel.channel_points_custom_reward_redemption.add",
      connectionId: account.id,
      onStale: "drop",
      maxAgeMs: 60_000,
    });

    const duplicate = await post(test, account.id, webhookSecret, {
      messageId: "msg-1",
      messageType: "notification",
      payload: delivery(account.twitchUserId, "sub-1"),
    });
    expect(duplicate.status).toBe(204);
    expect(test.relay.events).toHaveLength(1);

    const badSignature = await post(test, account.id, webhookSecret, {
      messageId: "msg-2",
      messageType: "notification",
      payload: delivery(account.twitchUserId, "sub-1"),
      secret: "wrong-secret",
    });
    expect(badSignature.status).toBe(403);

    const stale = await post(test, account.id, webhookSecret, {
      messageId: "msg-3",
      messageType: "notification",
      payload: delivery(account.twitchUserId, "sub-1"),
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    expect(stale.status).toBe(403);
  });

  it("marks a revoked subscription and notifies the machine", async () => {
    const test = await makeTestApp();
    const { account, webhookSecret } = await test.seedAccount({});
    const machine = await test.seedMachine(account.userId);
    await test.seedSubscription(account, machine.machineId, { providerSubscriptionId: "sub-1" });

    const revocation = await post(test, account.id, webhookSecret, {
      messageId: "revoke-1",
      messageType: "revocation",
      payload: {
        subscription: {
          id: "sub-1",
          status: "revoked",
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          condition: { broadcaster_user_id: account.twitchUserId },
        },
      },
    });
    expect(revocation.status).toBe(204);
    expect(test.relay.notifications).toEqual([
      expect.objectContaining({
        machineId: machine.machineId,
        message: expect.objectContaining({
          _tag: "subscription_revoked",
          providerSubscriptionId: "sub-1",
        }),
      }),
    ]);
    const stored = await Effect.runPromise(test.store.findSubscriptionByProviderId("sub-1"));
    expect(Option.getOrNull(stored)?.status).toBe("revoked");
  });
});

describe("EventSub subscription reconciliation", () => {
  it("creates, keeps and deletes provider subscriptions and enforces cost limits", async () => {
    const test = await makeTestApp();
    const { account } = await test.seedAccount({});
    const machine = await test.seedMachine(account.userId);
    const headers = { authorization: `Bearer ${machine.token}` };
    const spec = {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: 1,
      condition: { broadcaster_user_id: account.twitchUserId },
      onStale: "drop",
      maxAgeMs: 60_000,
    };

    const first = await test.request({
      method: "POST",
      path: "/api/twitch/subscriptions/reconcile",
      headers,
      body: { connectionId: account.id, subscriptions: [spec] },
    });
    expect(first.status).toBe(200);
    expect(json(first.body)).toMatchObject({ totalCost: 1, maxCost: 10 });
    expect(test.twitch.createdSubscriptions).toHaveLength(1);
    expect(test.twitch.createdSubscriptions[0]?.secret).toBe("event-sub-secret");

    const second = await test.request({
      method: "POST",
      path: "/api/twitch/subscriptions/reconcile",
      headers,
      body: { connectionId: account.id, subscriptions: [spec] },
    });
    expect(second.status).toBe(200);
    expect(test.twitch.createdSubscriptions).toHaveLength(1);

    const tooExpensive = await test.request({
      method: "POST",
      path: "/api/twitch/subscriptions/reconcile",
      headers,
      body: {
        connectionId: account.id,
        subscriptions: Array.from({ length: 11 }, (_, index) => ({
          ...spec,
          type: `channel.topic_${index}`,
        })),
      },
    });
    expect(tooExpensive.status).toBe(409);
    expect(json(tooExpensive.body)).toMatchObject({
      error: { tag: "cost_limit_exceeded", details: { totalCost: 11, maxCost: 10 } },
    });

    const empty = await test.request({
      method: "POST",
      path: "/api/twitch/subscriptions/reconcile",
      headers,
      body: { connectionId: account.id, subscriptions: [] },
    });
    expect(empty.status).toBe(200);
    expect(test.twitch.deletedSubscriptions).toEqual(["sub_1"]);
    expect(await Effect.runPromise(test.store.listSubscriptions(account.id))).toHaveLength(0);
  });
});
