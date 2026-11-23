import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The unit currently handling work, when there is one. */
export const UnitName = Context.Reference<string | undefined>(
  "Ballast/UnitName",
  { defaultValue: () => undefined },
);

/**
 * Attach a unit identity to a handler/run fiber. `annotateLogs` and
 * `annotateSpans` make the tag visible to loggers and tracing; the context
 * reference lets host code read it.
 */
export const withUnitHandler = <A, E, R>(
  name: string,
  handler: (value: A) => Effect.Effect<void, E, R>,
): ((value: A) => Effect.Effect<void, E, R>) =>
  (value) => withUnit(name, handler(value));

export const withUnit = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(UnitName, name),
    Effect.annotateLogs("unit", name),
    Effect.annotateSpans("ballast.unit", name),
  );
