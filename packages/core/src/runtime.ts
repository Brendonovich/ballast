import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Marks work that may only run while handling: subscription handlers,
 * `Ballast.run` loops, timer handlers and workflow bodies. Declarations never
 * require it; reading a param or calling a request/timer during init leaves
 * this service in the entry's requirements, which the plan gate rejects.
 */
export interface RuntimeService {}

export class Runtime extends Context.Service<Runtime, RuntimeService>()(
  "Ballast/Runtime",
) {}

const runtimeService: RuntimeService = {};

export const runtimeLayer: Layer.Layer<Runtime> = Layer.succeed(
  Runtime,
  runtimeService,
);

/** Provide the marker at a handler boundary. */
export const provideRuntime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Runtime>> =>
  Effect.provide(effect, runtimeLayer);
