import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";

import type { EventSubNotification, EventSubSession } from "./messages.ts";
import {
  decodeNotification,
  decodeWebSocketMessage,
  isWebSocketMessageType,
} from "./messages.ts";
import { EventSubRegistrar, type EventSubSubscriptionError } from "./registrar.ts";
import type { SubscriptionRequest } from "./subscriptions.ts";

export const DEFAULT_EVENTSUB_WEBSOCKET_URL = "wss://eventsub.wss.twitch.tv/ws";

export class EventSubSocketError extends Schema.TaggedError<EventSubSocketError>()(
  "EventSubSocketError",
  { reason: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {
  override get message() {
    return this.reason;
  }
}

export interface EventSubSocketOptions {
  /** Overridable for the Twitch CLI mock server and tests. */
  readonly url?: string;
  /** Subscriptions to create on every fresh session. */
  readonly subscriptions: ReadonlyArray<SubscriptionRequest>;
  /** Defaults to 10 seconds. */
  readonly handshakeTimeout?: Duration.Input;
  /** Added to the welcome message's keepalive timeout. Defaults to 5 seconds. */
  readonly keepaliveGrace?: Duration.Input;
  /** Defaults to 1 second. */
  readonly reconnectDelay?: Duration.Input;
  /** Defaults to 2048 message ids. */
  readonly dedupeCapacity?: number;
}

export interface EventSubSocketService {
  /** Typed notifications, deduplicated by Twitch message id. */
  readonly notifications: Stream.Stream<EventSubNotification>;
  /** The active WebSocket session id, if a session has been welcomed. */
  readonly sessionId: Effect.Effect<string | undefined>;
}

export class EventSubSocket extends Context.Service<EventSubSocket, EventSubSocketService>()(
  "Twitch/EventSubSocket",
) {}

const durationMillis = (input: Duration.Input): number => Duration.toMillis(input);

interface Dedupe {
  readonly seen: (messageId: string) => Effect.Effect<boolean>;
}

const makeDedupe = (capacity: number): Effect.Effect<Dedupe> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<{
      readonly ids: HashSet.HashSet<string>;
      readonly order: ReadonlyArray<string>;
    }>({ ids: HashSet.empty(), order: [] });

    return {
      seen: (messageId) =>
        Ref.modify(state, (current) => {
          if (HashSet.has(current.ids, messageId)) return [true, current] as const;
          const order = [...current.order, messageId];
          if (order.length <= capacity) {
            return [false, { ids: HashSet.add(current.ids, messageId), order }] as const;
          }
          const [oldest, ...rest] = order;
          return [
            false,
            {
              ids: HashSet.add(
                oldest === undefined ? current.ids : HashSet.remove(current.ids, oldest),
                messageId,
              ),
              order: rest,
            },
          ] as const;
        }),
    };
  });

const reconnectUrlOf = (session: EventSubSession): Effect.Effect<string, EventSubSocketError> =>
  session.reconnect_url === undefined || session.reconnect_url === null
    ? Effect.fail(
        new EventSubSocketError({ reason: "session_reconnect did not include a reconnect URL" }),
      )
    : Effect.succeed(session.reconnect_url);

const socketError = (cause: { readonly message: string }) =>
  new EventSubSocketError({ reason: cause.message, cause });

/**
 * EventSub's WebSocket transport (Twitch's "local" mode: no public webhook).
 *
 * The returned stream reconnects on socket loss, honours keepalive timeouts,
 * follows session_reconnect URLs, and drops duplicate message ids. New
 * subscriptions are created through EventSubRegistrar for every fresh session;
 * reconnects keep the session's existing subscriptions, as Twitch documents.
 */
export const make = (
  options: EventSubSocketOptions,
): Effect.Effect<
  EventSubSocketService,
  never,
  Scope.Scope | Socket.WebSocketConstructor | EventSubRegistrar
> =>
  Effect.gen(function* () {
    const registrar = yield* EventSubRegistrar;
    const notifications = yield* Queue.unbounded<EventSubNotification>();
    const sessionId = yield* Ref.make<string | undefined>(undefined);
    const dedupe = yield* makeDedupe(options.dedupeCapacity ?? 2048);
    const handshakeTimeout = options.handshakeTimeout ?? "10 seconds";
    const keepaliveGrace = options.keepaliveGrace ?? "5 seconds";
    const reconnectDelay = options.reconnectDelay ?? "1 second";
    const defaultUrl = options.url ?? DEFAULT_EVENTSUB_WEBSOCKET_URL;

    const processMessage = (
      raw: string,
    ): Effect.Effect<string | undefined, EventSubSocketError> =>
      decodeWebSocketMessage(raw).pipe(
        Effect.mapError(
          (cause) =>
            new EventSubSocketError({
              reason: "Invalid EventSub message: " + cause.message,
              cause,
            }),
        ),
        Effect.flatMap((message): Effect.Effect<string | undefined, EventSubSocketError> => {
          if (isWebSocketMessageType(message, "session_welcome")) {
            return Ref.set(sessionId, message.payload.session.id).pipe(Effect.as(undefined));
          }
          if (isWebSocketMessageType(message, "session_keepalive")) {
            return Effect.succeed(undefined);
          }
          if (isWebSocketMessageType(message, "session_reconnect")) {
            return reconnectUrlOf(message.payload.session);
          }
          if (isWebSocketMessageType(message, "revocation")) {
            return Effect.logWarning("Twitch revoked an EventSub subscription", {
              subscriptionId: message.payload.subscription.id,
              type: message.payload.subscription.type,
              status: message.payload.subscription.status,
            }).pipe(Effect.as(undefined));
          }
          return dedupe.seen(message.metadata.message_id).pipe(
            Effect.flatMap((seen) =>
              seen
                ? Effect.succeed(undefined)
                : decodeNotification(
                    message.payload.subscription.type,
                    message.payload.event,
                    {
                      messageId: message.metadata.message_id,
                      messageTimestamp: message.metadata.message_timestamp,
                      receivedAt: new Date(),
                      subscription: message.payload.subscription,
                    },
                  ).pipe(
                    Effect.matchEffect({
                      onFailure: (cause) =>
                        Effect.logWarning(
                          "Ignoring an EventSub notification that failed to decode",
                          {
                            type: message.payload.subscription.type,
                            error: cause.message,
                          },
                        ).pipe(Effect.as(undefined)),
                      onSuccess: (notification) =>
                        Queue.offer(notifications, notification).pipe(Effect.as(undefined)),
                    }),
                  ),
            ),
          );
        }),
      );

    const connectOnce = (
      url: string,
      fresh: boolean,
    ): Effect.Effect<string | undefined, EventSubSocketError, Socket.WebSocketConstructor> =>
      Effect.scoped(
        Effect.gen(function* () {
          const messages: Stream.Stream<
            string,
            Socket.SocketError,
            Socket.WebSocketConstructor
          > = Stream.never.pipe(
            Stream.pipeThroughChannel(Socket.makeWebSocketChannel(url)),
            Stream.decodeText(),
          );
          const pull = yield* Stream.toPull(messages);

          const read = (duration: Duration.Input) =>
            pull.pipe(
              Effect.timeout(duration),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new EventSubSocketError({
                    reason: "Timed out waiting for an EventSub WebSocket message",
                  }),
                ),
              ),
              Effect.catchTag("Done", () =>
                Effect.fail(new EventSubSocketError({ reason: "EventSub WebSocket closed" })),
              ),
              Effect.catchTag("SocketError", (cause) => Effect.fail(socketError(cause))),
            );

          const firstBatch = yield* read(handshakeTimeout);
          const firstRaw = firstBatch[0];
          if (firstRaw === undefined) {
            return yield* new EventSubSocketError({
              reason: "EventSub closed before its welcome",
            });
          }
          const first = yield* decodeWebSocketMessage(firstRaw).pipe(
            Effect.mapError(
              (cause) =>
                new EventSubSocketError({
                  reason: "Expected session_welcome: " + cause.message,
                  cause,
                }),
            ),
          );
          if (!isWebSocketMessageType(first, "session_welcome")) {
            return yield* new EventSubSocketError({
              reason: "Expected session_welcome, received " + first.metadata.message_type,
            });
          }

          const session = first.payload.session;
          yield* Ref.set(sessionId, session.id);

          if (fresh) {
            for (const request of options.subscriptions) {
              yield* registrar.create(session.id, request).pipe(
                Effect.mapError(
                  (cause: EventSubSubscriptionError) =>
                    new EventSubSocketError({
                      reason:
                        "Failed to create EventSub subscription " +
                        request.type +
                        ": " +
                        cause.message,
                      cause,
                    }),
                ),
              );
            }
          }

          const keepalive = Duration.millis(
            (session.keepalive_timeout_seconds ?? 10) * 1000 + durationMillis(keepaliveGrace),
          );

          const remainingFirstBatch = firstBatch.slice(1);
          for (const raw of remainingFirstBatch) {
            const reconnectUrl = yield* processMessage(raw);
            if (reconnectUrl !== undefined) return reconnectUrl;
          }

          while (true) {
            const batch = yield* read(keepalive);
            for (const raw of batch) {
              const reconnectUrl = yield* processMessage(raw);
              if (reconnectUrl !== undefined) return reconnectUrl;
            }
          }
        }),
      );

    const loop = Effect.gen(function* () {
      let nextUrl = defaultUrl;
      let fresh = true;
      while (true) {
        const result = yield* connectOnce(nextUrl, fresh).pipe(
          Effect.matchEffect({
            onSuccess: (reconnectUrl) => Effect.succeed({ _tag: "ended" as const, reconnectUrl }),
            onFailure: (error) =>
              Effect.logWarning("EventSub WebSocket connection ended; reconnecting", {
                reason: error.reason,
              }).pipe(Effect.as({ _tag: "failed" as const, reconnectUrl: undefined })),
          }),
        );
        if (result._tag === "ended" && result.reconnectUrl !== undefined) {
          nextUrl = result.reconnectUrl;
          fresh = false;
        } else {
          nextUrl = defaultUrl;
          fresh = true;
          yield* Effect.sleep(reconnectDelay);
        }
      }
    });

    yield* loop.pipe(Effect.forkScoped);

    return EventSubSocket.of({
      notifications: Stream.fromQueue(notifications),
      sessionId: Ref.get(sessionId),
    });
  });

/** Layer form for the runtime/agent wiring. */
export const layer = (
  options: EventSubSocketOptions,
): Layer.Layer<EventSubSocket, never, Socket.WebSocketConstructor | EventSubRegistrar> =>
  Layer.effect(EventSubSocket, make(options));
