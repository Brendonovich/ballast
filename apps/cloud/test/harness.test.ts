import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";

import {
  RelayClientMessage,
  encodeRelayServerMessage,
  type EventEnvelope,
  type RelayServerMessage,
} from "@ballast/cloud-protocol";

import type { RelayGatewayService } from "../src/relay/gateway.ts";
import {
  ackEvents,
  emptyRelaySnapshot,
  enqueueEvent,
  pendingCount,
  pendingEvents,
  type RelaySnapshot,
} from "../src/relay/state.ts";
import { computeEventSubSignature } from "../src/eventsub.ts";
import { makeTestApp } from "./support/test-app.ts";

class MemoryRelay {
  private snapshots = new Map<string, RelaySnapshot>();
  private sockets = new Map<string, WebSocket>();

  readonly gateway: RelayGatewayService = {
    enqueueEvent: (machineId, envelope) =>
      Effect.sync(() => {
        this.enqueue(machineId, envelope);
      }),
    notify: (machineId, message) =>
      Effect.sync(() => {
        const socket = this.sockets.get(machineId);
        if (socket !== undefined) socket.send(encodeRelayServerMessage(message));
      }),
  };

  private snapshot(machineId: string): RelaySnapshot {
    return this.snapshots.get(machineId) ?? emptyRelaySnapshot;
  }

  enqueue(machineId: string, envelope: EventEnvelope): void {
    const next = enqueueEvent(this.snapshot(machineId), envelope, Date.now());
    this.snapshots.set(machineId, next.snapshot);
    if (next.result.duplicate || next.result.seq === null) return;
    const socket = this.sockets.get(machineId);
    if (socket !== undefined) {
      socket.send(
        encodeRelayServerMessage({
          _tag: "event",
          seq: next.result.seq,
          envelope,
          stale: false,
        }),
      );
    }
  }

  connect(machineId: string, socket: WebSocket): void {
    const previous = this.sockets.get(machineId);
    if (previous !== undefined) previous.close(1012, "Replaced");
    this.sockets.set(machineId, socket);
    const pending = pendingEvents(this.snapshot(machineId), Date.now());
    this.snapshots.set(machineId, pending.snapshot);
    socket.send(
      encodeRelayServerMessage({
        _tag: "hello",
        machineId,
        serverTime: Date.now(),
        pending: pending.events.length,
      }),
    );
    for (const event of pending.events) {
      socket.send(
        encodeRelayServerMessage({
          _tag: "event",
          seq: event.seq,
          envelope: event.envelope,
          stale: event.stale,
        }),
      );
    }
  }

  message(machineId: string, data: string): void {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RelayClientMessage))(data);
    if (decoded._tag === "ack") {
      this.snapshots.set(
        machineId,
        ackEvents(this.snapshot(machineId), decoded.seqs, Date.now()),
      );
    }
  }

  pending(machineId: string): number {
    return pendingCount(this.snapshot(machineId));
  }
}

const envelope = (id: string, connectionId: string): EventEnvelope => ({
  id,
  integration: "twitch",
  topic: "twitch/channel.cheer",
  connectionId,
  occurredAt: Date.now() - 1_000,
  receivedAt: Date.now() - 1_000,
  payload: { bits: 100 },
  onStale: "drop",
  maxAgeMs: 60_000,
});

const waitFor = async (
  messages: ReadonlyArray<RelayServerMessage>,
  predicate: (message: RelayServerMessage) => boolean,
): Promise<RelayServerMessage> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = messages.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a relay message");
};

const headerRecord = (headers: Readonly<Record<string, string | string[] | undefined>>) =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      typeof value === "string"
        ? [[name.toLowerCase(), value] as const]
        : Array.isArray(value)
          ? [[name.toLowerCase(), value.join(",")] as const]
          : [],
    ),
  );

describe("local end-to-end harness", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it(
    "delivers a signed EventSub notification to a connected agent WebSocket",
    async () => {
      const relay = new MemoryRelay();
      const test = await makeTestApp({ relay: relay.gateway });
      const { account, webhookSecret } = await test.seedAccount({});
      const machine = await test.seedMachine(account.userId);
      await test.seedSubscription(account, machine.machineId, { providerSubscriptionId: "sub-1" });

      const wss = new WebSocketServer({ noServer: true });
      let port = 0;
      const server = createServer(async (request, response) => {
        const chunks: Array<Uint8Array> = [];
        for await (const chunk of request) chunks.push(new Uint8Array(chunk));
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const result = await Effect.runPromise(
          test.app.fetch({
            method: request.method ?? "GET",
            url: `http://127.0.0.1:${port}${request.url ?? "/"}`,
            headers: headerRecord(request.headers),
            body: new Uint8Array(body),
          }),
        );
        response.writeHead(result.status, result.headers ?? {});
        response.end(result.body);
      });

      server.on("upgrade", async (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
        const prefix = "/relay/";
        if (!url.pathname.startsWith(prefix)) {
          socket.destroy();
          return;
        }
        const machineId = decodeURIComponent(url.pathname.slice(prefix.length));
        const auth = await Effect.runPromise(
          test.app
            .authenticateMachine({
              method: "GET",
              url: url.toString(),
              headers: headerRecord(request.headers),
              body: new Uint8Array(),
            })
            .pipe(Effect.result),
        );
        if (Result.isFailure(auth) || auth.success.id !== machineId) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          relay.connect(machineId, ws);
          ws.on("message", (data) => relay.message(machineId, data.toString()));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
      servers.push({
        close: () =>
          new Promise<void>((resolve) => {
            wss.close();
            server.close(() => resolve());
          }),
      });

      // One event queued while the agent is offline must be delivered on connect.
      relay.enqueue(machine.machineId, envelope("buffered-1", account.id));

      const client = new WebSocket(`ws://127.0.0.1:${port}/relay/${machine.machineId}`, {
        headers: { authorization: `Bearer ${machine.token}` },
      });
      const messages: Array<RelayServerMessage> = [];
      client.on("message", (data) => {
        messages.push(JSON.parse(data.toString()) as RelayServerMessage);
      });
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });

      const hello = await waitFor(messages, (message) => message._tag === "hello");
      if (hello._tag !== "hello") throw new Error("Expected a hello message");
      expect(hello.pending).toBe(1);
      const buffered = await waitFor(
        messages,
        (message) => message._tag === "event" && message.envelope.id === "buffered-1",
      );
      if (buffered._tag !== "event") throw new Error("Expected a buffered event");
      expect(buffered.stale).toBe(false);

      const timestamp = new Date().toISOString();
      const messageId = "webhook-1";
      const payload = JSON.stringify({
        subscription: {
          id: "sub-1",
          status: "enabled",
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          condition: { broadcaster_user_id: account.twitchUserId },
        },
        event: {
          id: "redemption-1",
          reward: { title: "Hydrate", cost: 100 },
          user_name: "viewer",
        },
      });
      const signature = await Effect.runPromise(
        computeEventSubSignature(
          webhookSecret,
          messageId,
          timestamp,
          new TextEncoder().encode(payload),
        ),
      );
      const response = await fetch(
        `http://127.0.0.1:${port}/webhooks/twitch/eventsub/${account.id}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "twitch-eventsub-message-id": messageId,
            "twitch-eventsub-message-timestamp": timestamp,
            "twitch-eventsub-message-signature": signature,
            "twitch-eventsub-message-type": "notification",
          },
          body: payload,
        },
      );
      expect(response.status).toBe(204);

      const delivered = await waitFor(
        messages,
        (message) => message._tag === "event" && message.envelope.id === "twitch:webhook-1",
      );
      if (delivered._tag !== "event") throw new Error("Expected a delivered event");
      expect(delivered.envelope).toMatchObject({
        integration: "twitch",
        connectionId: account.id,
        payload: expect.objectContaining({ id: "redemption-1" }),
      });
      expect(relay.pending(machine.machineId)).toBe(2);

      client.send(JSON.stringify({ _tag: "ack", seqs: [buffered.seq, delivered.seq] }));
      for (let attempt = 0; attempt < 100 && relay.pending(machine.machineId) > 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(relay.pending(machine.machineId)).toBe(0);

      client.close();
    },
    20_000,
  );
});
