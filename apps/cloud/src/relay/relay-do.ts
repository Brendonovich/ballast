import {
  RelayClientMessage,
  encodeRelayServerMessage,
  type EventEnvelope,
  type RelayServerMessage,
} from "@ballast/cloud-protocol";
import { Schema } from "effect";
import { DurableObject } from "cloudflare:workers";

import type { CloudEnv } from "../../alchemy.run.ts";
import {
  ackEvents,
  emptyRelaySnapshot,
  enqueueEvent,
  eventMessage,
  pendingEvents,
  type RelaySnapshot,
} from "./state.ts";

const storageKey = "relay";
const socketTag = "relay";

/**
 * One Durable Object per machine.
 *
 * It owns the ordered event buffer and the agent's WebSocket. The Worker has
 * already authenticated the machine token before calling `fetch`, and the DO
 * namespace is not publicly routable, so the socket route trusts its caller.
 */
export class Relay extends DurableObject<CloudEnv> {
  private async load(): Promise<RelaySnapshot> {
    const stored = await this.ctx.storage.get<RelaySnapshot>(storageKey);
    return stored ?? emptyRelaySnapshot;
  }

  private save(snapshot: RelaySnapshot): Promise<void> {
    return this.ctx.storage.put(storageKey, snapshot);
  }

  private async broadcast(message: RelayServerMessage): Promise<void> {
    const encoded = encodeRelayServerMessage(message);
    for (const socket of this.ctx.getWebSockets(socketTag)) {
      try {
        socket.send(encoded);
      } catch {
        socket.close(1011, "Relay send failed");
      }
    }
  }

  async enqueue(envelope: EventEnvelope): Promise<void> {
    const next = enqueueEvent(await this.load(), envelope, Date.now());
    if (next.result.duplicate || next.result.seq === null) return;
    await this.save(next.snapshot);
    await this.broadcast({
      _tag: "event",
      seq: next.result.seq,
      envelope,
      stale: false,
    });
  }

  async notify(_machineId: string, message: RelayServerMessage): Promise<void> {
    await this.broadcast(message);
  }

  async fetch(request: Request): Promise<Response> {
    const machineId = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    if (machineId.length === 0)
      return new Response("Missing machine identity", { status: 400 });
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return new Response("Upgrade required", { status: 426 });

    for (const socket of this.ctx.getWebSockets(socketTag)) {
      socket.close(1012, "Replaced by a new connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [socketTag]);

    const pending = pendingEvents(await this.load(), Date.now());
    await this.save(pending.snapshot);
    server.send(
      encodeRelayServerMessage({
        _tag: "hello",
        machineId,
        serverTime: Date.now(),
        pending: pending.events.length,
      }),
    );
    for (const event of pending.events) {
      server.send(encodeRelayServerMessage(eventMessage(event)));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let decoded: RelayClientMessage;
    try {
      decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RelayClientMessage))(message);
    } catch {
      _socket.close(1003, "Invalid relay message");
      return;
    }
    if (decoded._tag === "ack") {
      const snapshot = await this.load();
      await this.save(ackEvents(snapshot, decoded.seqs, Date.now()));
    }
  }
}
