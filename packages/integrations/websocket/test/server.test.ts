import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { WebSocket } from "ws";
import { serverLayer as driverLayer, WebSocketServerDriver } from "../src/driver/index.ts";
import { layer as nodeListener } from "../src/driver/node.ts";

const connectClient = (url: string): Effect.Effect<WebSocket, Error, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(url);
          socket.once("open", () => resolve(socket));
          socket.once("error", reject);
        }),
      catch: (cause) => new Error(String(cause)),
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

const serverLayer = driverLayer.pipe(Layer.provide(nodeListener));

const waitFor = (milliseconds: number) => Effect.sleep(milliseconds);

interface Received {
  readonly messages: Array<string>;
}

describe("WebSocket server driver", () => {
  it.live("accepts clients, receives messages, broadcasts and reports disconnects", () =>
    Effect.gen(function* () {
      const driver = yield* WebSocketServerDriver;
      const server = yield* driver.listen({
        slot: "bridge",
        host: "127.0.0.1",
        port: 0,
      });
      expect(server.address.port).toBeGreaterThan(0);

      const clientA = yield* connectClient(
        "ws://127.0.0.1:" + server.address.port + (server.address.path ?? ""),
      );
      const clientB = yield* connectClient(
        "ws://127.0.0.1:" + server.address.port + (server.address.path ?? ""),
      );

      const receivedA: Received = { messages: [] };
      const receivedB: Received = { messages: [] };
      clientA.on("message", (data) => receivedA.messages.push(String(data)));
      clientB.on("message", (data) => receivedB.messages.push(String(data)));

      const connected = Array.from(
        yield* server.events.pipe(
          Stream.filter((event) => event._tag === "client_connected"),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );
      expect(connected).toHaveLength(2);

      clientA.send("from-a");
      clientB.send("from-b");
      const messages = Array.from(
        yield* server.events.pipe(
          Stream.filter((event) => event._tag === "message"),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        ),
      );
      const byClient = new Map(
        messages.flatMap((event) =>
          event._tag === "message" ? [[event.message.clientId, event.message.text]] as const : [],
        ),
      );
      expect(byClient.size).toBe(2);
      expect([...byClient.values()].sort()).toEqual(["from-a", "from-b"]);

      const broadcast = yield* server.broadcast({ type: "text", text: "hello" });
      expect(broadcast).toEqual({ delivered: 2, failed: 0 });
      yield* waitFor(100);
      expect(receivedA.messages).toEqual(["hello"]);
      expect(receivedB.messages).toEqual(["hello"]);

      const clients = yield* server.clients;
      const clientBInfo = clients[1];
      if (clientBInfo === undefined) throw new Error("missing second client");
      yield* server.sendToClient(clientBInfo.clientId, { type: "text", text: "only-b" });
      yield* waitFor(100);
      expect(receivedB.messages).toEqual(["hello", "only-b"]);
      expect(receivedA.messages).toEqual(["hello"]);

      clientA.close();
      yield* waitFor(100);
      const disconnected = yield* server.events.pipe(
        Stream.filter((event) => event._tag === "client_disconnected"),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );
      expect(Array.from(disconnected)).toHaveLength(1);
      expect((yield* server.clients).length).toBe(1);
    }).pipe(Effect.provide(serverLayer), Effect.scoped),
  );

  it.live("filters by path", () =>
    Effect.gen(function* () {
      const driver = yield* WebSocketServerDriver;
      const server = yield* driver.listen({
        slot: "path",
        host: "127.0.0.1",
        port: 0,
        path: "/only",
      });
      const accepted = yield* connectClient(
        "ws://127.0.0.1:" + server.address.port + "/only",
      );
      expect(accepted.readyState).toBe(1);

      const refused = yield* Effect.exit(
        Effect.scoped(
          Effect.tryPromise({
            try: () =>
              new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(
                  "ws://127.0.0.1:" + server.address.port + "/other",
                );
                socket.once("open", () => resolve(socket));
                socket.once("error", reject);
              }),
            catch: (cause) => new Error(String(cause)),
          }),
        ),
      );
      expect(refused._tag).toBe("Failure");
    }).pipe(Effect.provide(serverLayer), Effect.scoped),
  );
});
