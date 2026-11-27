import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
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

const serverLayer = driverLayer.pipe(
  Layer.provide(nodeListener),
  Layer.provide([NodeServices.layer, NodeCrypto.layer]),
);

describe("WebSocket server driver", () => {
  it.live("sendToClient delivers only to the addressed client", () =>
    Effect.gen(function* () {
      const driver = yield* WebSocketServerDriver;
      const server = yield* driver.listen({
        slot: "bridge",
        host: "127.0.0.1",
        port: 0,
      });

      const clientA = yield* connectClient("ws://127.0.0.1:" + server.address.port);
      const clientB = yield* connectClient("ws://127.0.0.1:" + server.address.port);

      const receivedA: Array<string> = [];
      const receivedB: Array<string> = [];
      clientA.on("message", (data) => receivedA.push(String(data)));
      clientB.on("message", (data) => receivedB.push(String(data)));

      yield* server.events.pipe(
        Stream.filter((event) => event._tag === "client_connected"),
        Stream.take(2),
        Stream.runDrain,
        Effect.timeout("5 seconds"),
      );

      const clients = yield* server.clients;
      const clientBInfo = clients[1];
      if (clientBInfo === undefined) throw new Error("missing second client");
      yield* server.sendToClient(clientBInfo.clientId, { type: "text", text: "only-b" });
      yield* Effect.sleep(100);
      expect(receivedB).toEqual(["only-b"]);
      expect(receivedA).toEqual([]);
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
