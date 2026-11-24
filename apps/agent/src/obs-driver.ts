import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  PubSub,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect/Scope";
import { Socket } from "effect/socket";
import {
  ConnectionUnavailable,
  ConnectionRequestFailed,
  type ConnectionRequestError,
} from "@ballast/core";
import {
  INTEGRATION,
  RequestSchemas,
  isRequestName,
  subscriptionMaskForTopics,
} from "@ballast/module-obs";
import { connectObsSocket, isObsAuthenticationError } from "./obs-protocol.ts";

/** Truthful lifecycle for the connection row and OBS.ConnectionState. */
export type ObsDriverStatus =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "connected"; readonly reconnected: boolean }
  | {
      readonly _tag: "disconnected";
      readonly error: string;
      readonly retryAt: number;
    }
  | { readonly _tag: "error"; readonly error: string };

export interface ObsDriver {
  readonly slot: string;
  readonly url: string;
  /** Completes on the first successful Identify. Later reconnects keep it completed. */
  readonly ready: Effect.Effect<void>;
  /** Call an obs-websocket request by its protocol name. */
  readonly request: (
    request: string,
    input: unknown,
  ) => Effect.Effect<unknown, ConnectionRequestError>;
  /** Replayed lifecycle status for the agent connection manager. */
  readonly statuses: Stream.Stream<ObsDriverStatus>;
}

export interface ObsDriverOptions {
  readonly slot: string;
  readonly url: string;
  readonly password?: string;
  /** Manifest topics for this slot, e.g. `obs/CurrentProgramSceneChanged`. */
  readonly topics: ReadonlyArray<string>;
  readonly publish: (topicKey: string, payload: unknown) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const topicKey = (slot: string, eventType: string): string =>
  INTEGRATION + "/" + slot + "/" + INTEGRATION + "/" + eventType;

const backoffMs = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);

/**
 * Keep one OBS connection alive. The driver reconnects with exponential
 * backoff (1s, 2s, 4s ... capped at 30s) and publishes every subscribed event
 * on the agent bus. Requests fail while disconnected instead of queueing, so a
 * stale scene change is never replayed after a reconnect.
 */
export const startObsDriver = (
  options: ObsDriverOptions,
): Effect.Effect<ObsDriver, never, Crypto.Crypto | Scope> =>
  Effect.gen(function* () {
    const current = yield* Ref.make<
      import("./obs-protocol.ts").ObsSocketClient | undefined
    >(undefined);
    const statuses = yield* PubSub.unbounded<ObsDriverStatus>({ replay: 8 });
    const publishStatus = (status: ObsDriverStatus): Effect.Effect<void> =>
      PubSub.publish(statuses, status).pipe(Effect.asVoid);
    const ready = yield* Deferred.make<void>();
    const connected = yield* Ref.make(false);
    const everConnected = yield* Ref.make(false);
    const subscriptionMask = subscriptionMaskForTopics(options.topics);
    const stateTopic = topicKey(options.slot, "ConnectionState");
    const stateSubscribed = options.topics.some((topic) => {
      const name = topic.startsWith(INTEGRATION + "/")
        ? topic.slice(INTEGRATION.length + 1)
        : topic;
      return name === "ConnectionState" || name.endsWith("/ConnectionState");
    });
    const publishState = (state: "connected" | "disconnected", reconnected: boolean) => {
      if (stateSubscribed) {
        options.publish(stateTopic, {
          state,
          reconnected,
          at: Date.now(),
        });
      }
    };

    const loop = Effect.gen(function* () {
      let attempt = 0;
      let announcedAttempt = false;

      while (true) {
        // Show `connecting` for the initial attempt only. Retries keep the
        // truthful disconnected state, so the row never flickers each backoff.
        if (!announcedAttempt) {
          announcedAttempt = true;
          yield* publishStatus({ _tag: "connecting" });
        }
        console.log("[obs:" + options.slot + "] connecting to " + options.url);
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connectObsSocket(
              options.url,
              options.password,
              subscriptionMask,
            ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));

            yield* Ref.set(current, client);
            attempt = 0;
            console.log("[obs:" + options.slot + "] connected (" + options.url + ")");
            yield* Ref.set(connected, true);
            const reconnected = yield* Ref.getAndSet(everConnected, true);
            publishState("connected", reconnected);
            yield* publishStatus({ _tag: "connected", reconnected });
            yield* Deferred.succeed(ready, undefined);

            yield* Effect.forkScoped(
              Effect.gen(function* () {
                while (true) {
                  const event = yield* Queue.take(client.events);
                  options.publish(topicKey(options.slot, event.eventType), event.eventData);
                }
              }),
            );

            yield* client.closed;
          }),
        ).pipe(Effect.exit);

        yield* Ref.set(current, undefined);
        if (yield* Ref.getAndSet(connected, false)) {
          publishState("disconnected", false);
        }
        const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined;
        const reason = failure === undefined ? "connection closed" : errorMessage(failure);
        if (isObsAuthenticationError(failure)) {
          const message =
            "OBS authentication failed at " + options.url + ": " + reason;
          console.error("[obs:" + options.slot + "] " + message + "; not retrying");
          yield* publishStatus({ _tag: "error", error: message });
          return;
        }

        const delay = backoffMs(attempt);
        attempt += 1;
        const retryAt = Date.now() + delay;
        const message = "OBS not reachable at " + options.url + " (" + reason + ")";
        console.log(
          "[obs:" + options.slot + "] " + message + "; reconnecting in " + delay + "ms",
        );
        yield* publishStatus({ _tag: "disconnected", error: message, retryAt });
        yield* Effect.sleep(delay);
      }
    });

    yield* Effect.forkScoped(loop);

    const request = (
      request: string,
      input: unknown,
    ): Effect.Effect<unknown, ConnectionRequestError> =>
      Effect.gen(function* () {
        if (!isRequestName(request)) {
          return yield* Effect.fail(
            new ConnectionRequestFailed({
              integration: INTEGRATION,
              slot: options.slot,
              message: 'Unknown OBS request "' + request + '"',
            }),
          );
        }

        const schemas = RequestSchemas[request];
        const decoded = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(schemas.input)(input ?? {}),
          catch: (cause) =>
            new ConnectionRequestFailed({
              integration: INTEGRATION,
              slot: options.slot,
              message: "Invalid " + request + " input: " + errorMessage(cause),
            }),
        });

        const client = yield* Ref.get(current);
        if (client === undefined) {
          return yield* Effect.fail(
            new ConnectionUnavailable({
              integration: INTEGRATION,
              slot: options.slot,
              message: "OBS " + options.slot + " is not connected",
            }),
          );
        }

        return yield* client.request(request, decoded).pipe(
          Effect.mapError(
            (error) =>
              new ConnectionRequestFailed({
                integration: INTEGRATION,
                slot: options.slot,
                message: errorMessage(error),
              }),
          ),
        );
      });

    return {
      slot: options.slot,
      url: options.url,
      ready: Deferred.await(ready),
      request,
      statuses: Stream.fromPubSub(statuses),
    };
  });
