import { Cause, Deferred, Effect, Exit, Queue, Ref, Schema } from "effect";
import type { Scope } from "effect/Scope";
import { Socket } from "effect/socket";
import {
  INTEGRATION,
  RequestSchemas,
  isRequestName,
  subscriptionMaskForTopics,
} from "@ballast/module-obs";
import { connectObsSocket } from "./obs-protocol.ts";

export interface ObsDriver {
  readonly slot: string;
  readonly url: string;
  /** Completes on the first successful Identify. Later reconnects keep it completed. */
  readonly ready: Effect.Effect<void>;
  /** Call an obs-websocket request by its protocol name. */
  readonly request: (request: string, input: unknown) => Effect.Effect<unknown, string>;
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
): Effect.Effect<ObsDriver, never, Scope> =>
  Effect.gen(function* () {
    const current = yield* Ref.make<
      import("./obs-protocol.ts").ObsSocketClient | undefined
    >(undefined);
    const ready = yield* Deferred.make<void>();
    const subscriptionMask = subscriptionMaskForTopics(options.topics);

    const loop = Effect.gen(function* () {
      let attempt = 0;

      while (true) {
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
        const reason = Exit.isFailure(result)
          ? errorMessage(Cause.squash(result.cause))
          : "connection closed";
        const delay = backoffMs(attempt);
        attempt += 1;
        console.log(
          "[obs:" + options.slot + "] " + reason + "; reconnecting in " + delay + "ms",
        );
        yield* Effect.sleep(delay);
      }
    });

    yield* Effect.forkScoped(loop);

    const request = (request: string, input: unknown): Effect.Effect<unknown, string> =>
      Effect.gen(function* () {
        if (!isRequestName(request)) {
          return yield* Effect.fail('Unknown OBS request "' + request + '"');
        }

        const schemas = RequestSchemas[request];
        const decoded = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(schemas.input)(input ?? {}),
          catch: (cause) =>
            "Invalid " + request + " input: " + errorMessage(cause),
        });

        const client = yield* Ref.get(current);
        if (client === undefined) {
          return yield* Effect.fail("OBS " + options.slot + " is not connected");
        }

        return yield* client.request(request, decoded).pipe(
          Effect.mapError((error) => errorMessage(error)),
        );
      });

    return {
      slot: options.slot,
      url: options.url,
      ready: Deferred.await(ready),
      request,
    };
  });
