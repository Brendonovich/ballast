import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HelixClient } from "../helix/client.ts";
import type { SubscriptionRequest } from "./subscriptions.ts";

export class EventSubSubscriptionError extends Schema.TaggedError<EventSubSubscriptionError>()(
  "EventSubSubscriptionError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export interface EventSubRegistrarService {
  /**
   * Create one EventSub subscription bound to a WebSocket session. Twitch's
   * Helix API is the only way to add subscriptions to a session.
   */
  readonly create: (
    sessionId: string,
    request: SubscriptionRequest,
  ) => Effect.Effect<void, EventSubSubscriptionError>;
}

/** Transport seam between the WebSocket client and Helix (or a test double). */
export class EventSubRegistrar extends Context.Service<
  EventSubRegistrar,
  EventSubRegistrarService
>()("Twitch/EventSubRegistrar") {}

export const layerHelix: Layer.Layer<EventSubRegistrar, never, HelixClient> = Layer.effect(
  EventSubRegistrar,
  Effect.gen(function* () {
    const helix = yield* HelixClient;
    return EventSubRegistrar.of({
      create: (sessionId, request) =>
        helix
          .createEventSubSubscription({
            type: request.type,
            version: String(request.version),
            condition: request.condition,
            transport: { method: "websocket", session_id: sessionId },
          })
          .pipe(
            Effect.mapError(
              (cause) => new EventSubSubscriptionError({ reason: cause.message }),
            ),
            Effect.asVoid,
          ),
    });
  }),
);

export const layerFromFunction = (
  create: EventSubRegistrarService["create"],
): Layer.Layer<EventSubRegistrar> =>
  Layer.succeed(EventSubRegistrar, EventSubRegistrar.of({ create }));
