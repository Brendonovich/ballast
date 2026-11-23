import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";
import { decodeBase64 } from "../base64.ts";
import type {
  WebSocketBroadcastResult,
  WebSocketClientDisconnected,
  WebSocketClientInfo,
  WebSocketConnectionStatus,
  WebSocketOutboundMessage,
  WebSocketServerConfig,
  WebSocketServerEvent,
  WebSocketServerMessage,
} from "../types.ts";
import { WebSocketDriverError } from "./errors.ts";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_BUFFER_SIZE = 256;

export interface WebSocketListenerClient {
  readonly socket: Socket.Socket;
  readonly remoteAddress?: string;
}

export interface WebSocketListenerServer {
  readonly address: {
    readonly host: string;
    readonly port: number;
    readonly path?: string;
  };
  readonly run: (
    onClient: (client: WebSocketListenerClient) => Effect.Effect<void>,
  ) => Effect.Effect<never, WebSocketDriverError>;
}

export class WebSocketListener extends Context.Service<
  WebSocketListener,
  {
    readonly listen: (options: {
      readonly host: string;
      readonly port: number;
      readonly path?: string;
      readonly maxMessageBytes: number;
    }) => Effect.Effect<WebSocketListenerServer, WebSocketDriverError, Scope.Scope>;
  }
>()("ballast/websocket/WebSocketListener") {}

export interface WebSocketServerConnection {
  readonly slot: string;
  readonly address: WebSocketListenerServer["address"];
  readonly status: Effect.Effect<WebSocketConnectionStatus>;
  readonly statusChanges: Stream.Stream<WebSocketConnectionStatus>;
  readonly clients: Effect.Effect<ReadonlyArray<WebSocketClientInfo>>;
  readonly events: Stream.Stream<WebSocketServerEvent>;
  readonly sendToClient: (
    clientId: string,
    message: WebSocketOutboundMessage,
  ) => Effect.Effect<void, WebSocketDriverError>;
  readonly broadcast: (
    message: WebSocketOutboundMessage,
  ) => Effect.Effect<WebSocketBroadcastResult, WebSocketDriverError>;
  readonly close: Effect.Effect<void>;
}

export class WebSocketServerDriver extends Context.Service<
  WebSocketServerDriver,
  {
    readonly listen: (
      config: WebSocketServerConfig,
    ) => Effect.Effect<WebSocketServerConnection, WebSocketDriverError, Scope.Scope>;
  }
>()("ballast/websocket/WebSocketServerDriver") {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const byteLength = (message: WebSocketOutboundMessage): number => {
  switch (message.type) {
    case "text":
      return new TextEncoder().encode(message.text).byteLength;
    case "binary":
      return decodeBase64(message.base64).byteLength;
    case "json":
      return new TextEncoder().encode(JSON.stringify(message.value)).byteLength;
  }
};

const encode = (message: WebSocketOutboundMessage): string | Uint8Array => {
  switch (message.type) {
    case "text":
      return message.text;
    case "binary":
      return decodeBase64(message.base64);
    case "json":
      return JSON.stringify(message.value);
  }
};

const disconnectedOf = (
  clientId: string,
  exit: Exit.Exit<void, Socket.SocketError>,
): WebSocketClientDisconnected => {
  if (Exit.isSuccess(exit)) {
    return { clientId, code: 1000, cause: "server", at: Date.now() };
  }
  const error = Cause.squash(exit.cause);
  if (Socket.isSocketError(error) && error.reason._tag === "SocketCloseError") {
    const reason = error.reason.closeReason;
    return {
      clientId,
      code: error.reason.code,
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      cause: error.reason.code === 1000 || error.reason.code === 1001 ? "peer" : "error",
      at: Date.now(),
    };
  }
  return {
    clientId,
    code: 1006,
    reason: errorMessage(error),
    cause: "error",
    at: Date.now(),
  };
};

const validateConfig = (config: WebSocketServerConfig): WebSocketDriverError | undefined => {
  if (config.slot.length === 0) {
    return new WebSocketDriverError({ reason: "WebSocket server slot must not be empty" });
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    return new WebSocketDriverError({
      reason: "WebSocket server port must be an integer from 0 to 65535",
    });
  }
  if (config.path !== undefined && !config.path.startsWith("/")) {
    return new WebSocketDriverError({ reason: "WebSocket server path must start with /" });
  }
  return undefined;
};

/** Standalone server driver; requires a `WebSocketListener` adapter. */
export const layer: Layer.Layer<
  WebSocketServerDriver,
  never,
  Crypto.Crypto | WebSocketListener
> =
  Layer.effect(
    WebSocketServerDriver,
    Effect.gen(function* () {
      const listener = yield* WebSocketListener;
      const crypto = yield* Crypto.Crypto;

      return WebSocketServerDriver.of({
        listen: (config) =>
          Effect.gen(function* () {
            const invalid = validateConfig(config);
            if (invalid !== undefined) return yield* invalid;

            const maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
            const status = yield* SubscriptionRef.make<WebSocketConnectionStatus>("connecting");
            const events = yield* Queue.bounded<WebSocketServerEvent>(
              config.bufferSize ?? DEFAULT_BUFFER_SIZE,
            );
            const clients = yield* Ref.make<ReadonlyMap<string, Socket.Writer>>(new Map());
            const clientIds = yield* Ref.make<ReadonlyMap<string, WebSocketClientInfo>>(new Map());

            const publish = (event: WebSocketServerEvent): Effect.Effect<void> =>
              Queue.offer(events, event).pipe(Effect.asVoid);

            const server = yield* listener.listen({
              host: config.host ?? "127.0.0.1",
              port: config.port,
              ...(config.path === undefined ? {} : { path: config.path }),
              maxMessageBytes,
            });

            const checked = (message: WebSocketOutboundMessage) =>
              byteLength(message) > maxMessageBytes
                ? Effect.fail(
                    new WebSocketDriverError({
                      reason:
                        "WebSocket server " + config.slot + " message is over the " + maxMessageBytes + " byte limit",
                    }),
                  )
                : Effect.void;

            const handleClient = (client: WebSocketListenerClient): Effect.Effect<void> =>
              Effect.gen(function* () {
                const clientId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                let registered = false;

                const exit = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function* () {
                      const writer = yield* client.socket.writer;
                      const reader = yield* client.socket.reader;
                      const info: WebSocketClientInfo = {
                        clientId,
                        connectedAt: Date.now(),
                      };
                      yield* Ref.update(clients, (current) =>
                        new Map(current).set(clientId, writer),
                      );
                      yield* Ref.update(clientIds, (current) =>
                        new Map(current).set(clientId, info),
                      );
                      registered = true;
                      yield* publish({ _tag: "client_connected", client: info });

                      while (true) {
                        const batch = yield* reader.pull;
                        for (const frame of batch) {
                          const size =
                            typeof frame === "string"
                              ? new TextEncoder().encode(frame).byteLength
                              : frame.byteLength;
                          if (size > maxMessageBytes) {
                            yield* Effect.logWarning(
                              "websocket server " + config.slot + " dropped an oversized frame",
                              { size, limit: maxMessageBytes },
                            );
                            continue;
                          }
                          const message: WebSocketServerMessage =
                            typeof frame === "string"
                              ? { clientId, text: frame, receivedAt: Date.now() }
                              : { clientId, binary: frame, receivedAt: Date.now() };
                          yield* publish({ _tag: "message", message });
                        }
                      }
                    }),
                  ),
                );

                if (!registered) return;

                yield* Ref.update(clients, (current) => {
                  const next = new Map(current);
                  next.delete(clientId);
                  return next;
                });
                yield* Ref.update(clientIds, (current) => {
                  const next = new Map(current);
                  next.delete(clientId);
                  return next;
                });
                yield* publish({
                  _tag: "client_disconnected",
                  client: disconnectedOf(clientId, exit),
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "websocket server " + config.slot + " client handler failed",
                    cause,
                  ),
                ),
              );

            const runFiber = yield* server
              .run(handleClient)
              .pipe(
                Effect.catch((error) =>
                  Effect.logError("websocket server " + config.slot + " stopped", error.message),
                ),
                Effect.forkScoped,
              );

            yield* SubscriptionRef.set(status, "running");

            const sendToClient = (clientId: string, message: WebSocketOutboundMessage) =>
              Effect.gen(function* () {
                yield* checked(message);
                const current = yield* Ref.get(clients);
                const writer = current.get(clientId);
                if (writer === undefined) {
                  return yield* new WebSocketDriverError({
                    reason:
                      "WebSocket server " + config.slot + " has no client " + clientId,
                  });
                }
                yield* writer.write(encode(message)).pipe(
                  Effect.mapError(
                    (error) =>
                      new WebSocketDriverError({ reason: errorMessage(error) }),
                  ),
                );
              });

            const broadcast = (message: WebSocketOutboundMessage) =>
              Effect.gen(function* () {
                yield* checked(message);
                const current = yield* Ref.get(clients);
                const results = yield* Effect.forEach(
                  [...current.values()],
                  (writer) =>
                    writer.write(encode(message)).pipe(
                      Effect.map(() => true),
                      Effect.catch(() => Effect.succeed(false)),
                    ),
                  { concurrency: 16 },
                );
                const delivered = results.filter((value) => value).length;
                return { delivered, failed: results.length - delivered };
              });

            return {
              slot: config.slot,
              address: server.address,
              status: SubscriptionRef.get(status),
              statusChanges: SubscriptionRef.changes(status),
              clients: Ref.get(clientIds).pipe(Effect.map((values) => [...values.values()])),
              events: Stream.fromQueue(events),
              sendToClient,
              broadcast,
              close: Effect.gen(function* () {
                yield* Fiber.interrupt(runFiber);
                yield* SubscriptionRef.set(status, "closed");
              }),
            };
          }),
      });
    }),
  );

