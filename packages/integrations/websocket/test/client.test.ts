import { describe, expect, it } from "@effect/vitest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { clientLayer as driverLayer, WebSocketClientDriver } from "../src/driver/index.ts";

interface TestServer {
  readonly url: string;
  readonly server: WebSocketServer;
  readonly connections: () => number;
}

const startServer = (
  onConnection: (socket: WebSocket, connection: number, request: IncomingMessage) => void,
): Effect.Effect<TestServer, Error, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<TestServer>((resolve, reject) => {
          const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          let count = 0;
          server.on("error", reject);
          server.on("listening", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("No WebSocket port"));
              return;
            }
            server.on("connection", (socket, request) => {
              count += 1;
              onConnection(socket, count, request);
            });
            resolve({
              url: "ws://127.0.0.1:" + address.port,
              server,
              connections: () => count,
            });
          });
        }),
      catch: (cause) => new Error(String(cause)),
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

const send = (socket: WebSocket, data: string | Uint8Array): void => {
  socket.send(data);
};

const clientLayer = driverLayer.pipe(
  Layer.provide(NodeWS.layerWebSocketConstructor),
);

describe("WebSocket client driver", () => {
  it.live("sends configured headers and subprotocols in the handshake", () =>
    Effect.gen(function* () {
      let handshake: Readonly<Record<string, string | string[] | undefined>> = {};
      const server = yield* startServer((_socket, _connection, request) => {
        handshake = request.headers;
      });

      const driver = yield* WebSocketClientDriver;
      const connection = yield* driver.connect({
        slot: "test",
        url: server.url,
        headers: { "x-ballast-test": "yes" },
        subprotocols: ["ballast.test"],
        reconnect: { enabled: false },
      });

      yield* connection.statusChanges.pipe(
        Stream.filter((status) => status === "open"),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("5 seconds"),
      );

      expect(handshake["x-ballast-test"]).toBe("yes");
      expect(handshake["sec-websocket-protocol"]).toBe("ballast.test");
    }).pipe(Effect.provide(clientLayer), Effect.scoped),
  );

  it.live("reconnects after a close and emits close events", () =>
    Effect.gen(function* () {
      const server = yield* startServer((socket, connection) => {
        send(socket, connection === 1 ? "first" : "second");
        socket.close();
      });

      const driver = yield* WebSocketClientDriver;
      const connection = yield* driver.connect({
        slot: "reconnect",
        url: server.url,
        reconnect: { initialDelayMs: 20, maxDelayMs: 50 },
      });

      const events = yield* connection.events.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );
      const list = Array.from(events);
      const messages = list.filter((event) => event._tag === "message");
      const open = list.filter((event) => event._tag === "open");
      const close = list.filter((event) => event._tag === "close");
      expect(
        messages.flatMap((event) => (event._tag === "message" ? [event.message.text] : [])),
      ).toEqual(["first", "second"]);
      expect(open.length).toBeGreaterThanOrEqual(2);
      expect(close.length).toBeGreaterThanOrEqual(1);
      expect(
        close.every((event) => event._tag !== "close" || event.close.willReconnect),
      ).toBe(true);
      expect(server.connections()).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(clientLayer), Effect.scoped),
  );

  it.live("rejects a non-websocket URL", () =>
    Effect.gen(function* () {
      const driver = yield* WebSocketClientDriver;
      const error = yield* driver.connect({
        slot: "bad",
        url: "http://example.com",
      }).pipe(Effect.flip);
      expect(error.reason).toContain("ws:// or wss://");
    }).pipe(Effect.provide(clientLayer), Effect.scoped),
  );
});
