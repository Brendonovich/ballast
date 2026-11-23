import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { WebSocket, WebSocketServer } from "ws";
import { ArtifactApi } from "./api.ts";
import { decodeClientMessage, toFromClientEncoded } from "./wire.ts";

const PORT = Number(process.env["SPIKE_PORT"] ?? "4311");
const ROOT = dirname(fileURLToPath(import.meta.url));

interface TokenGrant {
  readonly projectId: "demo";
  readonly scopes: ReadonlyArray<"read" | "action">;
}

/**
 * A real service issues these per project/artifact and stores a hash. The
 * spike keeps the plain values for readability.
 */
const TOKENS: ReadonlyMap<string, TokenGrant> = new Map([
  [
    "dashboard-action-token",
    { projectId: "demo", scopes: ["read", "action"] },
  ],
  ["dashboard-read-token", { projectId: "demo", scopes: ["read"] }],
]);

const tokenFrom = (url: URL): TokenGrant | undefined => {
  const token = url.searchParams.get("token");
  return token === null ? undefined : TOKENS.get(token);
};

const main = Effect.scoped(
  Effect.gen(function* () {
    const count = yield* Ref.make(1);
    const generation = 1;

    const clients = new Map<number, WebSocket>();
    const disconnects = yield* Queue.unbounded<number>();
    const services: { current: Context.Context<never> | undefined } = { current: undefined };
    let nextClientId = 1;
    let deliver: ((clientId: number, message: FromClientEncoded) => Effect.Effect<void>) | undefined;

    const protocol = yield* RpcServer.Protocol.make(
      Effect.fnUntraced(function* (writeRequest) {
        const context = yield* Effect.context<never>();
        services.current = context;
        deliver = writeRequest;

        return {
          disconnects,
          send: (clientId, response) =>
            Effect.sync(() => {
              const socket = clients.get(clientId);
              if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(response));
              }
            }),
          end: (clientId) =>
            Effect.sync(() => {
              clients.get(clientId)?.close();
            }),
          clientIds: Effect.sync(() => new Set(clients.keys())),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: Schema.toCodecJson,
        };
      }),
    );

    yield* Effect.forkScoped(
      RpcServer.make(ArtifactApi).pipe(
        Effect.provide(
          ArtifactApi.toLayer({
            Snapshot: () =>
              Effect.map(Ref.get(count), (value) => ({
                count: value,
                project: "demo",
                generation,
              })),
            Increment: ({ by }) => Ref.updateAndGet(count, (value) => value + by),
            Events: () =>
              Stream.tick("250 millis").pipe(
                Stream.mapEffect(() =>
                  Effect.map(Ref.get(count), (value) => ({
                    count: value,
                    at: Date.now(),
                  })),
                ),
              ),
          }),
        ),
        Effect.provideService(RpcServer.Protocol, protocol),
      ),
    );

    const wss = new WebSocketServer({ noServer: true });

    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
      }
      if (url.pathname === "/client.js") {
        void readFile(join(ROOT, "../public/client.js"), "utf8").then(
          (body) => {
            response.writeHead(200, { "content-type": "text/javascript" });
            response.end(body);
          },
          () => {
            response.writeHead(404);
            response.end("build public/client.js first");
          },
        );
        return;
      }
      if (url.pathname === "/") {
        if (tokenFrom(url) === undefined) {
          response.writeHead(401, { "content-type": "text/plain" });
          response.end("missing or invalid artifact token");
          return;
        }
        void readFile(join(ROOT, "../public/index.html"), "utf8").then(
          (body) => {
            response.writeHead(200, { "content-type": "text/html" });
            response.end(body);
          },
          () => {
            response.writeHead(404);
            response.end("missing public/index.html");
          },
        );
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });

    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const grant = tokenFrom(url);
      if (url.pathname !== "/rpc" || grant === undefined) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        const clientId = nextClientId;
        nextClientId += 1;
        clients.set(clientId, webSocket);
        console.log(
          "ARTIFACT_CONNECTED client=" +
            String(clientId) +
            " project=" +
            grant.projectId +
            " scopes=" +
            grant.scopes.join(","),
        );

        webSocket.on("message", (data) => {
          const text = typeof data === "string" ? data : data.toString();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            webSocket.close(1003, "invalid JSON");
            return;
          }
          const message = decodeClientMessage(parsed);
          const write = deliver;
          const context = services.current;
          if (write === undefined || context === undefined) {
            webSocket.close(1011, "RPC server not ready");
            return;
          }
          Effect.runForkWith(context)(
            write(clientId, toFromClientEncoded(message)).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.error("ARTIFACT_RPC_ERROR", String(cause));
                  webSocket.close(1011, "RPC write failed");
                }),
              ),
            ),
          );
        });

        webSocket.on("close", () => {
          clients.delete(clientId);
          Queue.offerUnsafe(disconnects, clientId);
        });

        webSocket.on("error", (cause) => {
          console.error("ARTIFACT_SOCKET_ERROR", String(cause));
        });
      });
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        httpServer.listen(PORT, "127.0.0.1", () => {
          console.log(
            "ARTIFACT_URL http://127.0.0.1:" + String(PORT) + "/?token=dashboard-action-token",
          );
        });
        return httpServer;
      }),
      (server) =>
        Effect.sync(() => {
          wss.close();
          server.close();
        }),
    );

    yield* Effect.never;
  }),
);

await Effect.runPromise(main);
