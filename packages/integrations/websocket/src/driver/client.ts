import * as Cause from "effect/Cause";
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
  WebSocketClientConfig,
  WebSocketClientEvent,
  WebSocketConnectionStatus,
  WebSocketMessage,
  WebSocketOutboundMessage,
  WebSocketReconnectPolicy,
} from "../types.ts";
import { WebSocketDriverError } from "./errors.ts";

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_BUFFER_SIZE = 256;

export interface WebSocketClientConnection {
  readonly slot: string;
  readonly url: string;
  readonly status: Effect.Effect<WebSocketConnectionStatus>;
  readonly statusChanges: Stream.Stream<WebSocketConnectionStatus>;
  readonly events: Stream.Stream<WebSocketClientEvent>;
  readonly send: (message: WebSocketOutboundMessage) => Effect.Effect<void, WebSocketDriverError>;
  readonly close: Effect.Effect<void>;
}

export class WebSocketClientDriver extends Context.Service<
  WebSocketClientDriver,
  {
    readonly connect: (
      config: WebSocketClientConfig,
    ) => Effect.Effect<WebSocketClientConnection, WebSocketDriverError, Scope.Scope>;
  }
>()("ballast/websocket/WebSocketClientDriver") {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const policyOf = (policy: WebSocketReconnectPolicy | undefined) => ({
  enabled: policy?.enabled ?? true,
  initialDelayMs: policy?.initialDelayMs ?? 500,
  maxDelayMs: policy?.maxDelayMs ?? 30_000,
  maxAttempts: policy?.maxAttempts,
});

const delayFor = (
  attempt: number,
  policy: ReturnType<typeof policyOf>,
): number =>
  Math.min(policy.initialDelayMs * 2 ** Math.min(attempt, 10), policy.maxDelayMs);

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

const messageOf = (frame: string | Uint8Array): WebSocketMessage =>
  typeof frame === "string"
    ? { text: frame, receivedAt: Date.now() }
    : { binary: frame, receivedAt: Date.now() };

const closeOf = (
  exit: Exit.Exit<void, Socket.SocketError>,
): { readonly code: number; readonly reason?: string } => {
  if (Exit.isSuccess(exit)) return { code: 1000 };
  const error = Cause.squash(exit.cause);
  if (Socket.isSocketError(error) && error.reason._tag === "SocketCloseError") {
    const reason = error.reason.closeReason;
    return {
      code: error.reason.code,
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
    };
  }
  return { code: 1006, reason: errorMessage(error) };
};

const validateConfig = (config: WebSocketClientConfig): WebSocketDriverError | undefined => {
  if (config.slot.length === 0) {
    return new WebSocketDriverError({ reason: "WebSocket client slot must not be empty" });
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return new WebSocketDriverError({ reason: `Invalid WebSocket URL: ${config.url}` });
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return new WebSocketDriverError({
      reason: `WebSocket URL must use ws:// or wss://, got ${url.protocol}`,
    });
  }
  if (url.username !== "" || url.password !== "") {
    return new WebSocketDriverError({
      reason: "WebSocket URLs must not contain credentials; put them in connection config headers",
    });
  }
  if (config.headers !== undefined) {
    for (const [name, value] of Object.entries(config.headers)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        return new WebSocketDriverError({ reason: "WebSocket headers must not contain CR or LF" });
      }
    }
  }
  return undefined;
};

/**
 * Standalone client driver. It owns reconnects and exposes one ordered event
 * stream; the agent maps those events onto manifest topic keys. `connect`
 * forks the socket loop into the caller's scope.
 */
export const layer: Layer.Layer<WebSocketClientDriver, never, Socket.WebSocketConstructor> =
  Layer.effect(
    WebSocketClientDriver,
    Effect.gen(function* () {
      const constructor = yield* Socket.WebSocketConstructor;
      const makeSocket = (
        url: string,
        options: {
          readonly openTimeout?: number;
          readonly protocols?: ReadonlyArray<string>;
          readonly headers?: Readonly<Record<string, string>>;
        },
      ) =>
        Socket.makeWebSocket(url, {
          ...(options.openTimeout === undefined ? {} : { openTimeout: options.openTimeout }),
          ...(options.protocols === undefined ? {} : { protocols: [...options.protocols] }),
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));

      return WebSocketClientDriver.of({
        connect: (config) =>
          Effect.gen(function* () {
            const invalid = validateConfig(config);
            if (invalid !== undefined) return yield* invalid;

            const events = yield* Queue.bounded<WebSocketClientEvent>(
              config.bufferSize ?? DEFAULT_BUFFER_SIZE,
            );
            const status = yield* SubscriptionRef.make<WebSocketConnectionStatus>("connecting");
            const writer = yield* Ref.make<Socket.Writer | undefined>(undefined);
            const stopping = yield* Ref.make(false);
            const maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
            const reconnect = policyOf(config.reconnect);
            let attempts = 0;

            const publish = (event: WebSocketClientEvent): Effect.Effect<void> =>
              Queue.offer(events, event).pipe(Effect.asVoid);

            const runSession = Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* makeSocket(config.url, {
                  openTimeout: config.openTimeoutMs ?? 10_000,
                  ...(config.subprotocols === undefined ? {} : { protocols: config.subprotocols }),
                  ...(config.headers === undefined ? {} : { headers: config.headers }),
                });
                const reader = yield* socket.reader;
                const socketWriter = yield* socket.writer;
                yield* Ref.set(writer, socketWriter);
                attempts = 0;
                yield* SubscriptionRef.set(status, "open");
                yield* publish({
                  _tag: "open",
                  open: { url: config.url, connectedAt: Date.now() },
                });

                while (true) {
                  const batch = yield* reader.pull;
                  for (const frame of batch) {
                    const size =
                      typeof frame === "string"
                        ? new TextEncoder().encode(frame).byteLength
                        : frame.byteLength;
                    if (size > maxMessageBytes) {
                      yield* Effect.logWarning(
                        "websocket/" + config.slot + " dropped an oversized frame",
                        { size, limit: maxMessageBytes },
                      );
                      continue;
                    }
                    yield* publish({ _tag: "message", message: messageOf(frame) });
                  }
                }
              }),
            );

            const loop = Effect.gen(function* () {
              while (true) {
                if (yield* Ref.get(stopping)) return;
                yield* SubscriptionRef.set(
                  status,
                  attempts === 0 ? "connecting" : "reconnecting",
                );

                const exit = yield* Effect.exit(runSession);

                yield* Ref.set(writer, undefined);
                if (yield* Ref.get(stopping)) return;

                const close = closeOf(exit);
                const nextAttempt = attempts + 1;
                const willReconnect =
                  reconnect.enabled &&
                  (reconnect.maxAttempts === undefined ||
                    nextAttempt <= reconnect.maxAttempts);

                yield* publish({
                  _tag: "close",
                  close: {
                    ...close,
                    willReconnect,
                    at: Date.now(),
                  },
                });

                if (!willReconnect) {
                  yield* SubscriptionRef.set(
                    status,
                    Exit.isFailure(exit) ? "error" : "closed",
                  );
                  return;
                }

                yield* SubscriptionRef.set(status, "reconnecting");
                yield* Effect.sleep(delayFor(attempts, reconnect));
                attempts = nextAttempt;
              }
            });

            const fiber = yield* Effect.forkScoped(loop);

            const close = Effect.gen(function* () {
              const alreadyStopping = yield* Ref.get(stopping);
              if (alreadyStopping) return;
              yield* Ref.set(stopping, true);
              yield* Fiber.interrupt(fiber);
              yield* SubscriptionRef.set(status, "closed");
            });

            return {
              slot: config.slot,
              url: config.url,
              status: SubscriptionRef.get(status),
              statusChanges: SubscriptionRef.changes(status),
              events: Stream.fromQueue(events),
              send: (message) =>
                Effect.gen(function* () {
                  const current = yield* SubscriptionRef.get(status);
                  if (current !== "open") {
                    return yield* new WebSocketDriverError({
                      reason:
                        "WebSocket " + config.slot + " is not open (status: " + current + ")",
                    });
                  }
                  const size = byteLength(message);
                  if (size > maxMessageBytes) {
                    return yield* new WebSocketDriverError({
                      reason:
                        "WebSocket " + config.slot + " message is " + size + " bytes, over the " + maxMessageBytes + " byte limit",
                    });
                  }
                  const socketWriter = yield* Ref.get(writer);
                  if (socketWriter === undefined) {
                    return yield* new WebSocketDriverError({
                      reason: "WebSocket " + config.slot + " has no open writer",
                    });
                  }
                  yield* socketWriter.write(encode(message)).pipe(
                    Effect.mapError(
                      (error) =>
                        new WebSocketDriverError({
                          reason: errorMessage(error),
                        }),
                    ),
                  );
                }),
              close,
            };
          }),
      });
    }),
  );

