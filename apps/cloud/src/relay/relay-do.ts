import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  RelayClientMessage,
  encodeRelayServerMessage,
  type EventEnvelope,
  type RelayServerMessage,
  type WebhookRelayDelivery,
} from "@ballast/cloud-protocol";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Clock, Effect, Exit, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  ackMessages,
  emptyRelaySnapshot,
  enqueueEvent,
  enqueueWebhook,
  eventMessage,
  pendingMessages,
  webhookMessage,
  type RelaySnapshot,
} from "./state.ts";

const storageKey = "relay";
const socketTag = "relay";

export interface RelayShape {
  /** Append an event and broadcast it to the connected agent. */
  readonly enqueue: (envelope: EventEnvelope) => Effect.Effect<void, never, RuntimeContext>;
  /** Send a non-buffered control message, such as a revocation. */
  readonly notify: (
    machineId: string,
    message: RelayServerMessage,
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** Buffer a generic webhook delivery in the same seq/ack space as events. */
  readonly enqueueWebhook: (
    delivery: WebhookRelayDelivery,
    policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" },
  ) => Effect.Effect<void, never, RuntimeContext>;
}

/**
 * One Durable Object per machine.
 *
 * It owns the ordered event buffer and the agent's WebSocket. The Worker has
 * already authenticated the machine token before forwarding the upgrade, and
 * the DO namespace is not publicly routable, so the socket route trusts its
 * caller.
 */
export class Relay extends Cloudflare.DurableObject<Relay, RelayShape>()("Relay") {}

export const RelayLive = Relay.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const load = () =>
        state.storage.get<RelaySnapshot>(storageKey).pipe(
          Effect.map((stored) => stored ?? emptyRelaySnapshot),
        );

      const save = (snapshot: RelaySnapshot) => state.storage.put(storageKey, snapshot);

      const broadcast = (message: RelayServerMessage) =>
        Effect.gen(function* () {
          const encoded = encodeRelayServerMessage(message);
          for (const socket of yield* state.getWebSockets(socketTag)) {
            const sent = yield* Effect.exit(socket.send(encoded));
            if (Exit.isFailure(sent))
              yield* socket.close(1011, "Relay send failed").pipe(Effect.ignore);
          }
        });

      const enqueue = (envelope: EventEnvelope) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const next = enqueueEvent(yield* load(), envelope, now);
          if (next.result.duplicate || next.result.seq === null) return;
          yield* save(next.snapshot);
          yield* broadcast({
            _tag: "event",
            seq: next.result.seq,
            envelope,
            stale: false,
          });
        });

      const notify = (_machineId: string, message: RelayServerMessage) =>
        broadcast(message);

      const enqueueWebhookDelivery = (
        delivery: WebhookRelayDelivery,
        policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" },
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const next = enqueueWebhook(yield* load(), delivery, policy, now);
          if (next.result.duplicate || next.result.seq === null) return;
          yield* save(next.snapshot);
          yield* broadcast({
            _tag: "webhook_delivery",
            seq: next.result.seq,
            stale: false,
            delivery,
          });
        });

      return {
        enqueue,
        notify,
        enqueueWebhook: enqueueWebhookDelivery,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://relay");
          const machineId = decodeURIComponent(
            url.pathname.split("/").filter((segment) => segment.length > 0).pop() ?? "",
          );
          if (machineId.length === 0)
            return HttpServerResponse.text("Missing machine identity", { status: 400 });
          if ((request.headers["upgrade"] ?? "").toLowerCase() !== "websocket")
            return HttpServerResponse.text("Upgrade required", { status: 426 });

          for (const socket of yield* state.getWebSockets(socketTag))
            yield* socket.close(1012, "Replaced by a new connection");

          const [response, server] = yield* Cloudflare.upgrade({ tags: [socketTag] });
          const now = yield* Clock.currentTimeMillis;
          const pending = pendingMessages(yield* load(), now);
          yield* save(pending.snapshot);
          yield* server.send(
            encodeRelayServerMessage({
              _tag: "hello",
              machineId,
              serverTime: now,
              pending: pending.messages.length,
            }),
          );
          for (const message of pending.messages)
            yield* server.send(
              encodeRelayServerMessage(
                message._tag === "event"
                  ? eventMessage(message.event)
                  : webhookMessage(message.webhook),
              ),
            );

          return response;
        }),
        webSocketMessage: (socket: Cloudflare.WebSocket, message: string | ArrayBuffer) => {
          if (typeof message !== "string") return Effect.void;
          let decoded: RelayClientMessage;
          try {
            decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RelayClientMessage))(message);
          } catch {
            return socket.close(1003, "Invalid relay message");
          }
          if (decoded._tag !== "ack") return Effect.void;
          return Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* save(ackMessages(yield* load(), decoded.seqs, now));
          });
        },
      };
    });
  }),
);
