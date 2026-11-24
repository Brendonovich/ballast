import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * A tagged failure thrown by an Effect crossing into Solid. The original
 * Schema.TaggedError instance is rethrown by Effect.runPromise, so its _tag and
 * fields survive; this type is the narrowed view a type guard returns.
 */
export interface TaggedFailure<Tag extends string> extends Error {
  readonly _tag: Tag;
}

/**
 * Narrow an unknown error from <Errored> or an action rejection to a tagged
 * failure. The runtime value is the original tagged error, so its message and
 * any fields the guard's tag identifies are available without casts.
 */
export const isTaggedError =
  <Tag extends string>(tag: Tag) =>
  (error: unknown): error is TaggedFailure<Tag> => {
    if (!(error instanceof Error)) return false;
    const value: unknown = Reflect.get(error, "_tag");
    return value === tag;
  };

/** A message for an unknown thrown failure, tagged or not. */
export const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Run an Effect as a Promise for a Solid async computation. The promise rejects
 * with the original typed failure (for example SwitchSceneError), so any
 * failure boundary that catches the read receives the tagged error.
 *
 * Use this for read-only project API calls inside createMemo/createStore or
 * directly in an async computation.
 */
export const query = <A, E>(source: () => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(source());

/**
 * Run an Effect as a Promise for a Solid action generator. Yielding this from
 * action(function* () { ... }) keeps the mutation in the action's transaction
 * and rejects with the original typed failure, so optimistic writes revert when
 * the caller does not catch the error.
 */
export const mutation = <A, E>(source: () => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(source());

/**
 * Turn an Effect Stream into an AsyncIterable. Return it from a Solid 2
 * computation (or pass it through from()) to consume every frame; Solid closes
 * the iterator when the computation is superseded.
 */
export const stream = <A, E>(
  source: () => Stream.Stream<A, E>,
): AsyncIterable<A> => Stream.toAsyncIterable(source());

export interface CollectOptions {
  /** Keep only the newest N values. */
  readonly limit?: number;
}

/**
 * Turn an Effect Stream into an AsyncIterable of accumulated frames. Each frame
 * is the list so far, which makes a stream directly usable as a Solid list:
 *
 * const chat = createMemo(() => collect(() => client.api.ChatHistory(), { limit: 200 }));
 * <For each={chat() ?? []}>...</For>
 */
export const collect = <A, E>(
  source: () => Stream.Stream<A, E>,
  options: CollectOptions = {},
): AsyncIterable<ReadonlyArray<A>> => {
  const limit = options.limit;
  const append = (
    items: ReadonlyArray<A>,
    value: A,
  ): readonly [ReadonlyArray<A>, ReadonlyArray<ReadonlyArray<A>>] => {
    const next = [...items, value];
    const kept =
      limit === undefined
        ? next
        : next.slice(Math.max(0, next.length - limit));
    return [kept, [kept]];
  };
  return Stream.toAsyncIterable(
    source().pipe(Stream.mapAccum((): ReadonlyArray<A> => [], append)),
  );
};
