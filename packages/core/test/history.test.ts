import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ballast from "../src/index.ts";

const Payload = Schema.Struct({ n: Schema.Number });

const Topic = Ballast.Topic<
  Schema.Schema.Type<typeof Payload>,
  "fake",
  Ballast.HistoryOptions
>({
  integration: "fake",
  topic: "fake/history",
  schema: Payload,
  history: { maxEntries: 10, retention: "1 hour" },
});

const connection: Ballast.ConnectionRef<"fake"> = {
  integration: "fake",
  slot: "main",
  location: "local",
};

const runtime = Ballast.Runtime.of({});

const eventNumbers = (entries: Iterable<Ballast.HistoryEntry<{ n: number }>>) =>
  Array.from(entries, (entry) => (entry._tag === "Event" ? entry.event.n : -1));

const subscribeWithHistory = Effect.gen(function* () {
  let deliver: ((event: unknown) => Effect.Effect<void, unknown>) | undefined;
  const eventHost: Ballast.EventHostService = {
    subscribe: (topic, _connection, handler) =>
      Effect.sync(() => {
        const schema = topic.schema;
        deliver = (event) =>
          schema === undefined
            ? Effect.void
            : Effect.flatMap(
                Effect.sync(() => Schema.decodeUnknownSync(Schema.toCodecJson(schema))(event)),
                handler,
              );
      }),
  };

  const subscription = yield* Topic.subscribe(
    "history",
    connection,
    () => Effect.void,
    { history: { maxEntries: 3, retention: "1 hour" } },
  ).pipe(Effect.provideService(Ballast.EventHost, Ballast.EventHost.of(eventHost)));

  if (deliver === undefined) return yield* Effect.die(new Error("event host was not subscribed"));
  return { subscription, deliver };
});

describe("subscription event history", () => {
  it.effect("pages newest-first and continues from a before cursor", () =>
    Effect.gen(function* () {
      const { subscription, deliver } = yield* subscribeWithHistory;
      yield* deliver({ n: 1 });
      yield* deliver({ n: 2 });
      yield* deliver({ n: 3 });

      const newest = yield* subscription
        .query({ limit: 2 })
        .pipe(Effect.provideService(Ballast.Runtime, runtime));
      expect(eventNumbers(newest)).toEqual([3, 2]);

      const cursor = newest.at(-1)?.cursor;
      const older = yield* subscription
        .query({ limit: 2, ...(cursor === undefined ? {} : { before: cursor }) })
        .pipe(Effect.provideService(Ballast.Runtime, runtime));
      expect(eventNumbers(older)).toEqual([1]);
    }).pipe(Effect.provide(Ballast.EventHistoryHostMemory)),
  );

  it.effect("watch emits entries recorded after it starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { subscription, deliver } = yield* subscribeWithHistory;
        const watched = yield* Effect.forkScoped(
          subscription.watch().pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.provideService(Ballast.Runtime, runtime),
          ),
        );
        yield* Effect.yieldNow;
        yield* deliver({ n: 4 });
        expect(eventNumbers(yield* Fiber.join(watched))).toEqual([4]);
      }),
    ).pipe(Effect.provide(Ballast.EventHistoryHostMemory)),
  );

  it.effect("returns rows with a different schema fingerprint only with includeLegacy", () =>
    Effect.gen(function* () {
      const { subscription, deliver } = yield* subscribeWithHistory;
      yield* deliver({ n: 1 });
      const host = yield* Ballast.EventHistoryHost;
      yield* host.record({ name: "history", fingerprint: "older-schema", event: { n: 99 } });

      const withLegacy = yield* subscription
        .query({ limit: 10, includeLegacy: true })
        .pipe(Effect.provideService(Ballast.Runtime, runtime));
      expect(withLegacy.some((entry) => entry._tag === "Legacy")).toBe(true);

      const currentOnly = yield* subscription
        .query({ limit: 10 })
        .pipe(Effect.provideService(Ballast.Runtime, runtime));
      expect(currentOnly.every((entry) => entry._tag === "Event")).toBe(true);
    }).pipe(Effect.provide(Ballast.EventHistoryHostMemory)),
  );
});
