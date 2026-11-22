import { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Effect, Layer } from "effect";

import type { EventEnvelope, RelayServerMessage } from "@ballast/cloud-protocol";

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
}

export class RelayGateway extends Context.Service<RelayGateway, RelayGatewayService>()(
  "Ballast/RelayGateway",
) {}

/** The DO namespace surface used by the Worker. Kept structural so tests need no Cloudflare types. */
export interface RelayNamespace {
  readonly getByName: (name: string) => {
    readonly enqueue: (
      envelope: EventEnvelope,
    ) => Effect.Effect<void, unknown, import("alchemy/RuntimeContext").RuntimeContext>;
    readonly notify: (
      machineId: string,
      message: RelayServerMessage,
    ) => Effect.Effect<void, unknown, import("alchemy/RuntimeContext").RuntimeContext>;
  };
}

/**
 * The DO method types carry the DO's `RuntimeContext` requirement even though
 * the cross-boundary RPC stub never touches it. Capture the Worker's context
 * once so callers of the gateway stay transport-agnostic.
 */
export const layerRelayGateway = (namespace: RelayNamespace) =>
  Layer.effect(
    RelayGateway,
    Effect.gen(function* () {
      const runtime = yield* RuntimeContext;
      return RelayGateway.of({
        enqueueEvent: (machineId, envelope) =>
          namespace
            .getByName(machineId)
            .enqueue(envelope)
            .pipe(
              Effect.provideService(RuntimeContext, runtime),
              Effect.mapError((cause) => new RelayError({ operation: "save", cause })),
              Effect.orDie,
            ),
        notify: (machineId, message) =>
          namespace
            .getByName(machineId)
            .notify(machineId, message)
            .pipe(
              Effect.provideService(RuntimeContext, runtime),
              Effect.mapError((cause) => new RelayError({ operation: "save", cause })),
              Effect.orDie,
            ),
      });
    }),
  );

/** Used by tests and the local Node harness. */
export const layerMemoryRelayGateway = (handlers: {
  readonly enqueueEvent: (machineId: string, envelope: EventEnvelope) => void;
  readonly notify: (machineId: string, message: RelayServerMessage) => void;
}) =>
  Layer.succeed(
    RelayGateway,
    RelayGateway.of({
      enqueueEvent: (machineId, envelope) =>
        Effect.sync(() => handlers.enqueueEvent(machineId, envelope)),
      notify: (machineId, message) => Effect.sync(() => handlers.notify(machineId, message)),
    }),
  );
