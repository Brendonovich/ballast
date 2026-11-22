import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Clock, Context, Data, Effect, Layer, Ref, Semaphore } from "effect";

import type { EventEnvelope } from "@ballast/cloud-protocol";

import {
  ackEvents,
  emptyRelaySnapshot,
  enqueueEvent,
  pendingCount,
  pendingEvents,
  pruneRelay,
  type PendingEvent,
  type RelayOptions,
  type RelaySnapshot,
} from "./state.ts";

export class RelayError extends Data.TaggedError("RelayError")<{
  readonly operation: "load" | "save";
  readonly cause: unknown;
}> {}

export interface RelayStateStoreService {
  readonly load: Effect.Effect<RelaySnapshot, RelayError, RuntimeContext>;
  readonly save: (snapshot: RelaySnapshot) => Effect.Effect<void, RelayError, RuntimeContext>;
}

export class RelayStateStore extends Context.Service<RelayStateStore, RelayStateStoreService>()(
  "Ballast/RelayStateStore",
) {}

export interface RelayBufferService {
  readonly enqueue: (
    envelope: EventEnvelope,
  ) => Effect.Effect<
    { readonly duplicate: boolean; readonly seq: number | null },
    RelayError,
    RuntimeContext
  >;
  readonly pending: Effect.Effect<ReadonlyArray<PendingEvent>, RelayError, RuntimeContext>;
  readonly ack: (seqs: ReadonlyArray<number>) => Effect.Effect<void, RelayError, RuntimeContext>;
  readonly prune: Effect.Effect<void, RelayError, RuntimeContext>;
  readonly count: Effect.Effect<number, RelayError, RuntimeContext>;
}

export class RelayBuffer extends Context.Service<RelayBuffer, RelayBufferService>()(
  "Ballast/RelayBuffer",
) {}

export const layerRelayBuffer = (options?: RelayOptions) =>
  Layer.effect(
    RelayBuffer,
    Effect.gen(function* () {
      const store = yield* RelayStateStore;
      const lock = Semaphore.makeUnsafe(1);

      const update = <A>(
        operation: (
          snapshot: RelaySnapshot,
          now: number,
        ) => { readonly snapshot: RelaySnapshot; readonly value: A },
      ) =>
        lock.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* store.load;
            const now = yield* Clock.currentTimeMillis;
            const next = operation(snapshot, now);
            yield* store.save(next.snapshot);
            return next.value;
          }),
        );

      return RelayBuffer.of({
        enqueue: (envelope) =>
          update((snapshot, now) => {
            const next = enqueueEvent(snapshot, envelope, now, options);
            return { snapshot: next.snapshot, value: next.result };
          }),
        pending: lock.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* store.load;
            const now = yield* Clock.currentTimeMillis;
            const next = pendingEvents(snapshot, now, options);
            yield* store.save(next.snapshot);
            return next.events;
          }),
        ),
        ack: (seqs) =>
          update((snapshot, now) => ({
            snapshot: ackEvents(snapshot, seqs, now),
            value: undefined,
          })).pipe(Effect.asVoid),
        prune: update((snapshot, now) => ({
          snapshot: pruneRelay(snapshot, now, options),
          value: undefined,
        })).pipe(Effect.asVoid),
        count: lock.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* store.load;
            return pendingCount(snapshot);
          }),
        ),
      });
    }),
  );

export const layerMemoryRelayState = (initial: RelaySnapshot = emptyRelaySnapshot) =>
  Layer.effect(
    RelayStateStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      return RelayStateStore.of({
        load: Ref.get(ref),
        save: (snapshot) => Ref.set(ref, snapshot),
      });
    }),
  );
