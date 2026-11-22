import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ConnectionLocation, ConnectionManifest } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { ManifestRecorder } from "./services.ts";

/**
 * A handle on a configured connection slot. The integration literal is part of
 * the type so a topic from one integration cannot be subscribed with another
 * integration's connection.
 */
export interface ConnectionRef<Integration extends string = string> {
  readonly integration: Integration;
  readonly slot: string;
  readonly location: ConnectionLocation;
}

export interface ConnectionSpec<Integration extends string = string> {
  readonly integration: Integration;
  readonly slot: string;
  readonly location: ConnectionLocation;
  /**
   * Request names this connection grants. Use `"*"` to grant the
   * integration's whole request namespace (recorded as `<integration>/*`).
   * Local integrations such as OBS have no scopes, so a connection is the
   * grant.
   */
  readonly requests?: ReadonlyArray<string>;
}

export const toConnectionManifest = (
  connection: ConnectionRef,
): ConnectionManifest => ({
  integration: connection.integration,
  slot: connection.slot,
  location: connection.location,
});

/**
 * Declare a connection slot. Plan mode records the requirement into the
 * manifest; runtime mode returns the same handle for request clients and the
 * agent's local connection drivers.
 */
export const Connection = <Integration extends string>(
  spec: ConnectionSpec<Integration>,
): Effect.Effect<ConnectionRef<Integration>> =>
  Effect.gen(function* () {
    const phase = yield* currentPhase;

    if (phase === "plan") {
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      yield* Option.match(recorder, {
        onNone: () =>
          Effect.die(
            new Error(`Connection "${spec.integration}/${spec.slot}" was declared in plan phase without a ManifestRecorder`),
          ),
        onSome: (service) =>
          Effect.gen(function* () {
            yield* service.connection(toConnectionManifest(spec));
            for (const request of spec.requests ?? []) {
              yield* service.request({
                integration: spec.integration,
                slot: spec.slot,
                request: request === "*" ? `${spec.integration}/*` : request,
                scopes: [],
              });
            }
          }),
      });
    }

    return {
      integration: spec.integration,
      slot: spec.slot,
      location: spec.location,
    };
  });
