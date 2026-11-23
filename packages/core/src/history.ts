import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type {
  EventHistoryHostService,
  HistoryRecord,
} from "./history-types.ts";
import type { RuntimeRpcClient } from "./runtime-rpc.ts";

export class EventHistoryHost extends Context.Service<
  EventHistoryHost,
  EventHistoryHostService
>()("Ballast/EventHistoryHost") {}

const pubsubFor = (
  subscriptions: Ref.Ref<ReadonlyMap<string, PubSub.PubSub<HistoryRecord>>>,
  name: string,
): Effect.Effect<PubSub.PubSub<HistoryRecord>> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(subscriptions);
    const existing = current.get(name);
    if (existing !== undefined) return existing;
    const created = yield* PubSub.unbounded<HistoryRecord>();
    yield* Ref.update(subscriptions, (map) => new Map(map).set(name, created));
    return created;
  });

const page = (
  records: ReadonlyArray<HistoryRecord>,
  input: { readonly limit: number; readonly before?: string | undefined },
): ReadonlyArray<HistoryRecord> => {
  const end =
    input.before === undefined
      ? records.length
      : records.findIndex((record) => record.cursor === input.before);
  return records
    .slice(0, end === -1 ? records.length : end)
    .slice(-Math.max(1, Math.min(input.limit, 500)))
    .reverse();
};

/** In-memory history host for core tests and `ballast run`. */
export const EventHistoryHostMemory: Layer.Layer<EventHistoryHost> = Layer.effect(
  EventHistoryHost,
  Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<HistoryRecord>>>(
      new Map(),
    );
    const subscriptions = yield* Ref.make<
      ReadonlyMap<string, PubSub.PubSub<HistoryRecord>>
    >(new Map());
    let cursor = 0;
    return EventHistoryHost.of({
      record: (input) =>
        Effect.gen(function* () {
          cursor += 1;
          const record: HistoryRecord = {
            cursor: String(cursor),
            receivedAt: Date.now(),
            fingerprint: input.fingerprint,
            event: input.event,
          };
          yield* Ref.update(records, (current) => {
            const next = new Map(current);
            next.set(input.name, [...(next.get(input.name) ?? []), record]);
            return next;
          });
          const pubsub = yield* pubsubFor(subscriptions, input.name);
          yield* PubSub.publish(pubsub, record);
        }),
      query: (input) =>
        Ref.get(records).pipe(
          Effect.map((current) => page(current.get(input.name) ?? [], input)),
        ),
      watch: (name) => pubsubFor(subscriptions, name),
    });
  }),
);

/** Worker-side history host backed by the runtime RPC client plus a local live stream. */
export const makeEventHistoryHostRuntime = (
  client: RuntimeRpcClient,
): Effect.Effect<EventHistoryHostService> =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make<
      ReadonlyMap<string, PubSub.PubSub<HistoryRecord>>
    >(new Map());
    return {
      record: (input) =>
        Effect.gen(function* () {
          const record = yield* client.EventHistoryRecord(input).pipe(Effect.orDie);
          const pubsub = yield* pubsubFor(subscriptions, input.name);
          yield* PubSub.publish(pubsub, record);
        }),
      query: (input) =>
        client
          .EventHistoryQuery({
            name: input.name,
            limit: input.limit,
            ...(input.before === undefined ? {} : { before: input.before }),
          })
          .pipe(Effect.orDie),
      watch: (name) => pubsubFor(subscriptions, name),
    };
  });
