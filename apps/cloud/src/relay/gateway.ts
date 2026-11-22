import { Context, Effect, Layer } from "effect";

import type {
  EventEnvelope,
  RelayServerMessage,
  WebhookRelayDelivery,
} from "@ballast/cloud-protocol";

import { RelayError } from "./buffer.ts";

/** The per-machine relay, as seen by the HTTP app. */
export interface RelayGatewayService {
  readonly enqueueEvent: (
    machineId: string,
    envelope: EventEnvelope,
  ) => Effect.Effect<void, RelayError>;
  /** A non-buffered message, such as a subscription revocation. */
  readonly notify: (
    machineId: string,
    message: RelayServerMessage,
  ) => Effect.Effect<void, RelayError>;
  readonly enqueueWebhook: (
    machineId: string,
    delivery: WebhookRelayDelivery,
    policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" },
  ) => Effect.Effect<void, RelayError>;
}

export class RelayGateway extends Context.Service<RelayGateway, RelayGatewayService>()(
  "Ballast/RelayGateway",
) {}

/** Used by tests and the local Node harness. */
export const layerMemoryRelayGateway = (handlers: {
  readonly enqueueEvent: (machineId: string, envelope: EventEnvelope) => void;
  readonly notify: (machineId: string, message: RelayServerMessage) => void;
  readonly enqueueWebhook?: (
    machineId: string,
    delivery: WebhookRelayDelivery,
    policy: { readonly maxAgeMs: number; readonly onStale: "drop" | "deliver" },
  ) => void;
}) =>
  Layer.succeed(
    RelayGateway,
    RelayGateway.of({
      enqueueEvent: (machineId, envelope) =>
        Effect.sync(() => handlers.enqueueEvent(machineId, envelope)),
      notify: (machineId, message) => Effect.sync(() => handlers.notify(machineId, message)),
      enqueueWebhook: (machineId, delivery, policy) =>
        Effect.sync(() => handlers.enqueueWebhook?.(machineId, delivery, policy)),
    }),
  );
