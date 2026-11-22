// Local demo: requires `pnpm dev:local` (wrangler dev --local) to be running on :8787.
// It starts a fake Twitch provider on :4010, runs OAuth/pairing/reconcile, sends a signed
// EventSub notification while the agent is offline and another while it is connected, and
// prints what the relay WebSocket delivers. No real Twitch credentials are used.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const cloud = "http://127.0.0.1:8787";
const twitch = "http://127.0.0.1:4010";
const encoder = new TextEncoder();

let webhookSecret = "";
const providerSubscriptions = [];
let nextId = 1;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

const fakeTwitch = createServer(async (req, res) => {
  const url = new URL(req.url, twitch);
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    const form = new URLSearchParams(body);
    const grant = form.get("grant_type");
    if (grant === "client_credentials") {
      return json(res, 200, {
        access_token: "app-access",
        expires_in: 3600,
        token_type: "bearer",
      });
    }
    return json(res, 200, {
      access_token: grant === "refresh_token" ? "refreshed-access" : "local-access",
      refresh_token: "local-refresh",
      expires_in: 3600,
      scope: ["user:read:email", "channel:read:redemptions"],
      token_type: "bearer",
    });
  }
  if (req.method === "GET" && url.pathname === "/helix/users") {
    return json(res, 200, {
      data: [
        {
          id: "12345",
          login: "streamer",
          display_name: "Streamer",
          email: "streamer@example.com",
        },
      ],
    });
  }
  if (req.method === "GET" && url.pathname === "/helix/eventsub/subscriptions") {
    return json(res, 200, { data: providerSubscriptions, total: providerSubscriptions.length });
  }
  if (req.method === "POST" && url.pathname === "/helix/eventsub/subscriptions") {
    const payload = JSON.parse(body);
    webhookSecret = payload.transport.secret;
    const id = `sub-local-${nextId++}`;
    providerSubscriptions.push({
      id,
      type: payload.type,
      version: payload.version,
      condition: payload.condition,
      status: "enabled",
      transport: { method: "webhook", callback: payload.transport.callback },
    });
    return json(res, 202, { data: [providerSubscriptions.at(-1)] });
  }
  if (req.method === "DELETE" && url.pathname === "/helix/eventsub/subscriptions") {
    const id = url.searchParams.get("id");
    const index = providerSubscriptions.findIndex((subscription) => subscription.id === id);
    if (index >= 0) providerSubscriptions.splice(index, 1);
    res.writeHead(204);
    return res.end();
  }
  return json(res, 404, { error: "not found", path: url.pathname });
});

await new Promise((resolve) => fakeTwitch.listen(4010, "127.0.0.1", resolve));

const request = async (path, options = {}) => {
  const response = await fetch(`${cloud}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
};

try {
  const start = await fetch(`${cloud}/oauth/twitch/start?scopes=user:read:email,channel:read:redemptions`, {
    redirect: "manual",
  });
  const authorize = new URL(start.headers.get("location"));
  const state = authorize.searchParams.get("state");
  console.log("oauth start:", start.status, authorize.origin + authorize.pathname);

  const callback = await request(
    `/oauth/twitch/callback?code=demo-code&state=${state}&format=json`,
  );
  console.log("oauth callback:", callback.status, callback.text);
  if (callback.status !== 200) { throw new Error("OAuth callback failed"); }
  const pairingCode = callback.body.pairingCode;
  const accountId = callback.body.accountId;

  const claim = await request("/api/pairing/claim", {
    method: "POST",
    body: JSON.stringify({ code: pairingCode, machineName: "Local demo" }),
  });
  console.log("pairing claim:", claim.status, claim.body.machineId);
  const machineToken = claim.body.machineToken;

  const reconcile = await request("/api/twitch/subscriptions/reconcile", {
    method: "POST",
    headers: { authorization: `Bearer ${machineToken}` },
    body: JSON.stringify({
      connectionId: accountId,
      subscriptions: [
        {
          type: "channel.channel_points_custom_reward_redemption.add",
          version: 1,
          condition: { broadcaster_user_id: "12345" },
          onStale: "drop",
          maxAgeMs: 60000,
        },
      ],
    }),
  });
  console.log(
    "reconcile:",
    reconcile.status,
    "cost",
    reconcile.body.totalCost,
    "provider",
    reconcile.body.subscriptions[0]?.providerSubscriptionId,
  );

  const sign = async (messageId, timestamp, payload) => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const message = encoder.encode(messageId + timestamp + payload);
    const signature = await crypto.subtle.sign("HMAC", key, message);
    return (
      "sha256=" +
      Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
  };

  const notification = (redemptionId) => {
    const messageId = `demo-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
      subscription: {
        id: reconcile.body.subscriptions[0].providerSubscriptionId,
        status: "enabled",
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: { broadcaster_user_id: "12345" },
      },
      event: {
        id: redemptionId,
        broadcaster_user_id: "12345",
        user_id: "999",
        user_name: "viewer",
        reward: { id: "reward-1", title: "Hydrate", cost: 100 },
        redeemed_at: timestamp,
      },
    });
    return { messageId, timestamp, payload };
  };

  // Send one event while the agent is offline. The relay must buffer it.
  const offline = notification("redemption-offline");
  const offlineResponse = await fetch(`${cloud}/webhooks/twitch/eventsub/${accountId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": offline.messageId,
      "twitch-eventsub-message-timestamp": offline.timestamp,
      "twitch-eventsub-message-signature": await sign(
        offline.messageId,
        offline.timestamp,
        offline.payload,
      ),
      "twitch-eventsub-message-type": "notification",
    },
    body: offline.payload,
  });
  console.log("offline webhook:", offlineResponse.status);

  const socket = new WebSocket(`ws://127.0.0.1:8787/relay/${claim.body.machineId}`, {
    headers: { authorization: `Bearer ${machineToken}` },
  });
  const messages = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    console.log("relay ->", message._tag, message._tag === "event" ? message.envelope.payload.id : "");
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const online = notification("redemption-online");
  const onlineResponse = await fetch(`${cloud}/webhooks/twitch/eventsub/${accountId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "twitch-eventsub-message-id": online.messageId,
      "twitch-eventsub-message-timestamp": online.timestamp,
      "twitch-eventsub-message-signature": await sign(
        online.messageId,
        online.timestamp,
        online.payload,
      ),
      "twitch-eventsub-message-type": "notification",
    },
    body: online.payload,
  });
  console.log("online webhook:", onlineResponse.status);

  await sleep(1500);
  const events = messages.filter((message) => message._tag === "event");
  console.log(
    "RESULT",
    JSON.stringify({
      hello: messages.find((message) => message._tag === "hello") ?? null,
      eventIds: events.map((message) => message.envelope.payload.id),
      bufferedStale: events.map((message) => message.stale),
    }),
  );

  socket.send(
    JSON.stringify({ _tag: "ack", seqs: events.map((message) => message.seq) }),
  );
  await sleep(300);
  socket.close();
} finally {
  await new Promise((resolve) => fakeTwitch.close(resolve));
}
