import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import {
  decodeWebhookRelayFrame,
  WebhookRelay,
  webhookRelayLayerNode,
} from "../src/driver/index.ts";

interface TestRelay {
  readonly port: number;
  readonly received: Array<unknown>;
  readonly server: WebSocketServer;
}

const startRelay = (
  frames: ReadonlyArray<unknown>,
): Effect.Effect<TestRelay, Error, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<TestRelay>((resolve, reject) => {
          const received: Array<unknown> = [];
          const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          server.on("error", reject);
          server.on("listening", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("no port"));
              return;
            }
            server.on("connection", (socket: WebSocket) => {
              socket.on("message", (data) => {
                received.push(JSON.parse(String(data)) as unknown);
              });
              for (const frame of frames) socket.send(JSON.stringify(frame));
            });
            resolve({ port: address.port, received, server });
          });
        }),
      catch: (cause) => new Error(String(cause)),
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

describe("webhook relay frames", () => {
  it.effect("decodes the proposed webhook_delivery frame and ignores unknown tags", () =>
    Effect.sync(() => {
      const delivery = {
        hookId: "hook_abc",
        deliveryId: "delivery-1",
        method: "POST",
        path: "/hooks/kofi",
        query: { a: "1" },
        headers: { "x-kofi-token": "secret" },
        bodyBase64: "aGVsbG8=",
        receivedAt: 123,
      };
      expect(
        decodeWebhookRelayFrame({
          _tag: "webhook_delivery",
          seq: 7,
          delivery,
        }),
      ).toEqual({ _tag: "webhook_delivery", seq: 7, stale: false, delivery });
      expect(decodeWebhookRelayFrame({ _tag: "event", seq: 1 })).toBeUndefined();
      expect(decodeWebhookRelayFrame({ _tag: "webhook_delivery", seq: 1 })).toBeUndefined();
    }),
  );

  it.live("consumes deliveries and acknowledges them over the relay socket", () =>
    Effect.gen(function* () {
      const relay = yield* startRelay([
        { _tag: "hello", machineId: "machine-1", serverTime: 1, pending: 0 },
        { _tag: "ping", at: 123 },
        {
          _tag: "webhook_delivery",
          seq: 7,
          delivery: {
            hookId: "hook_abc",
            deliveryId: "delivery-1",
            method: "POST",
            path: "/hooks/kofi",
            query: {},
            headers: {},
            bodyBase64: "aGVsbG8=",
            receivedAt: 123,
          },
        },
      ]);

      const serviceLayer = webhookRelayLayerNode({
        baseUrl: "http://127.0.0.1:" + relay.port,
        machineId: "machine-1",
        machineToken: "machine-token",
      });

      const deliveries = yield* Effect.gen(function* () {
        const relayService = yield* WebhookRelay;
        return yield* relayService.deliveries.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
        );
      }).pipe(Effect.provide(serviceLayer));

      expect(Array.from(deliveries)[0]?.deliveryId).toBe("delivery-1");
      yield* Effect.sleep("100 millis");
      expect(relay.received).toEqual([
        { _tag: "pong", at: 123 },
        { _tag: "ack", seqs: [7] },
      ]);
    }).pipe(Effect.scoped),
  );
});
