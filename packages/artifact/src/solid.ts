import { createEffect, createResource, createSignal, onCleanup } from "solid-js";
import type { ResourceReturn } from "solid-js";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

/** Run an Effect as a Solid resource. */
export const createQuery = <A, E>(
  query: () => Effect.Effect<A, E>,
): ResourceReturn<A> =>
  createResource(() => Effect.runPromise(query()));

export interface StreamResourceOptions {
  readonly limit?: number;
}

/**
 * Collect a stream into a Solid accessor. The stream is interrupted when the
 * owning component is cleaned up.
 */
export const createStream = <A, E>(
  stream: () => Stream.Stream<A, E>,
  options: StreamResourceOptions = {},
): (() => ReadonlyArray<A>) => {
  const [items, setItems] = createSignal<ReadonlyArray<A>>([]);
  createEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(stream(), (value) =>
        Effect.sync(() =>
          setItems((current) => {
            const next = [...current, value];
            return options.limit === undefined
              ? next
              : next.slice(Math.max(0, next.length - options.limit));
          }),
        ),
      ),
    );
    onCleanup(() => {
      void Effect.runPromise(Fiber.interrupt(fiber));
    });
  });
  return items;
};
