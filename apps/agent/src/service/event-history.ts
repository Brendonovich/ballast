import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { HistoryPolicy, HistoryQuery, HistoryRecord } from "@ballast/core";
import type { Json } from "effect/Schema";
import { ensureDir, writeTextAtomic } from "./fs.ts";
import type { ProjectRecord } from "./projects.ts";

/**
 * Durable, per-subscription inbound event history. One append-only JSONL file
 * per subscription under `.ballast/history`, with the manifest's effective
 * policy. The agent records every matched inbound event here before the worker
 * sees it, so a reload never loses events.
 */
export interface EventHistorySubscription {
  /** Stable subscription name; also the history file name. */
  readonly name: string;
  readonly integration: string;
  readonly slot: string;
  readonly topic: string;
  readonly policy: HistoryPolicy | false;
  /** Fingerprint of the topic schema stored with every entry. */
  readonly fingerprint: string;
}

export interface EventHistoryRegistration {
  readonly projectId: string;
  readonly scriptId: string;
  readonly root: string;
  readonly subscriptions: ReadonlyArray<EventHistorySubscription>;
}

export interface EventHistoryItem {
  readonly projectId: string;
  readonly subscription: EventHistorySubscription;
  readonly record: HistoryRecord;
}

export interface EventHistoryFilter {
  readonly subscription?: string;
  readonly integration?: string;
  readonly topic?: string;
  readonly afterCursor?: string;
  readonly limit?: number;
}

export interface EventHistoryService {
  readonly register: (registration: EventHistoryRegistration) => Effect.Effect<void>;
  readonly unregister: (projectId: string) => Effect.Effect<void>;
  readonly subscriptions: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<EventHistorySubscription>>;
  /** Persist one inbound event for a project subscription. */
  readonly record: (
    projectId: string,
    key: string,
    event: Json,
    options?: { readonly dedupe?: boolean },
  ) => Effect.Effect<HistoryRecord | undefined>;
  /** Newest first, capped by limit. */
  readonly query: (
    projectId: string,
    name: string,
    query: HistoryQuery,
  ) => Effect.Effect<ReadonlyArray<HistoryRecord>>;
  /** Every subscription's retained records, oldest first. */
  readonly replay: (
    projectId: string,
    filter?: EventHistoryFilter,
  ) => Effect.Effect<ReadonlyArray<EventHistoryItem>>;
  /** Live records appended after the stream starts. */
  readonly live: (projectId: string, filter?: EventHistoryFilter) => Stream.Stream<EventHistoryItem>;
}

export class EventHistory extends Context.Service<EventHistory, EventHistoryService>()(
  "ballast/service/EventHistory",
) {}

const HistoryRecordLine = Schema.Struct({
  cursor: Schema.String,
  receivedAt: Schema.Number,
  fingerprint: Schema.String,
  event: Schema.Unknown,
});
type HistoryRecordLine = typeof HistoryRecordLine.Type;

const fileFor = (path: Path.Path, registration: EventHistoryRegistration, name: string): string =>
  path.join(
    registration.root,
    ".ballast",
    "history",
    encodeURIComponent(name) + ".jsonl",
  );

interface SubscriptionState {
  readonly loaded: boolean;
  readonly records: ReadonlyArray<HistoryRecordLine>;
  readonly nextCursor: number;
}

const emptyState: SubscriptionState = { loaded: false, records: [], nextCursor: 1 };

const parseLine = (line: string): HistoryRecordLine | undefined => {
  if (line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownOption(HistoryRecordLine)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

const cursorNumber = (cursor: string): number => {
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const readState = (
  file: string,
): Effect.Effect<SubscriptionState, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined) return emptyState;
    const records: Array<HistoryRecordLine> = [];
    for (const line of text.split("\n")) {
      const parsed = parseLine(line);
      if (parsed !== undefined) records.push(parsed);
    }
    const nextCursor =
      records.reduce((next, record) => Math.max(next, cursorNumber(record.cursor) + 1), 1);
    return { loaded: true, records, nextCursor };
  });

const retained = (
  records: ReadonlyArray<HistoryRecordLine>,
  policy: HistoryPolicy,
  now: number,
): ReadonlyArray<HistoryRecordLine> =>
  records
    .filter((record) => now - record.receivedAt <= policy.retentionMs)
    .slice(Math.max(0, records.length - policy.maxEntries));

const serialize = (records: ReadonlyArray<HistoryRecordLine>): string =>
  records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");

const toHistoryRecord = (line: HistoryRecordLine): HistoryRecord => ({
  cursor: line.cursor,
  receivedAt: line.receivedAt,
  fingerprint: line.fingerprint,
  event: line.event,
});

const matches = (subscription: EventHistorySubscription, filter: EventHistoryFilter | undefined): boolean =>
  filter === undefined ||
  ((filter.subscription === undefined || filter.subscription === subscription.name) &&
    (filter.integration === undefined || filter.integration === subscription.integration) &&
    (filter.topic === undefined || filter.topic === subscription.topic));

export const EventHistoryLive = Layer.effect(
  EventHistory,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const semaphore = yield* Semaphore.make(1);
    const registrations = yield* Ref.make<ReadonlyMap<string, EventHistoryRegistration>>(
      new Map(),
    );
    const states = yield* Ref.make<ReadonlyMap<string, SubscriptionState>>(new Map());
    const changes = yield* PubSub.unbounded<EventHistoryItem>();
    const platform = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);

    const stateKey = (projectId: string, name: string): string => projectId + "\u0000" + name;

    const subscriptionOf = (
      projectId: string,
      key: string,
    ): Effect.Effect<EventHistorySubscription | undefined> =>
      Ref.get(registrations).pipe(
        Effect.map((current) =>
          current
            .get(projectId)
            ?.subscriptions.find(
              (subscription) =>
                subscription.name === key ||
                subscription.integration + "/" + subscription.slot + "/" + subscription.topic === key,
            ),
        ),
      );

    const stateFor = (
      registration: EventHistoryRegistration,
      subscription: EventHistorySubscription,
    ): Effect.Effect<SubscriptionState, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const key = stateKey(registration.projectId, subscription.name);
        const current = yield* Ref.get(states);
        const existing = current.get(key);
        if (existing?.loaded === true) return existing;
        const loaded = yield* readState(fileFor(path, registration, subscription.name));
        yield* Ref.update(states, (map) => new Map(map).set(key, loaded));
        return loaded;
      });

    const register: EventHistoryService["register"] = (registration) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          yield* Ref.update(registrations, (current) => {
            const next = new Map(current);
            next.set(registration.projectId, registration);
            return next;
          });
        }),
      );

    const unregister: EventHistoryService["unregister"] = (projectId) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          yield* Ref.update(registrations, (current) => {
            const next = new Map(current);
            next.delete(projectId);
            return next;
          });
        }),
      );

    const record: EventHistoryService["record"] = (projectId, key, event, options) =>
      semaphore.withPermit(
        provide(
          Effect.gen(function* () {
            const current = yield* Ref.get(registrations);
            const registration = current.get(projectId);
            const subscription = yield* subscriptionOf(projectId, key);
            if (registration === undefined || subscription === undefined) return undefined;
            if (subscription.policy === false) return undefined;
            const file = fileFor(path, registration, subscription.name);
            const state = yield* stateFor(registration, subscription);
            const receivedAt = Date.now();
            if (options?.dedupe === true) {
              const encoded = JSON.stringify(event);
              const delivered = [...state.records]
                .reverse()
                .find(
                  (entry) =>
                    entry.fingerprint === subscription.fingerprint &&
                    receivedAt - entry.receivedAt <= 30_000 &&
                    JSON.stringify(entry.event) === encoded,
                );
              if (delivered !== undefined) return toHistoryRecord(delivered);
            }
            const line: HistoryRecordLine = {
              cursor: String(state.nextCursor),
              receivedAt,
              fingerprint: subscription.fingerprint,
              event,
            };
            const appended = [...state.records, line];
            const kept = retained(appended, subscription.policy, receivedAt);
            const dropped = kept.length !== appended.length;
            const rotate = dropped || appended.length > subscription.policy.maxEntries * 2;
            if (rotate) {
              yield* ensureDir(path.dirname(file)).pipe(Effect.orDie);
              yield* writeTextAtomic(file, serialize(kept), 0o600).pipe(Effect.orDie);
            } else {
              yield* ensureDir(path.dirname(file)).pipe(Effect.orDie);
              const fs = yield* FileSystem.FileSystem;
              yield* fs
                .writeFileString(file, JSON.stringify(line) + "\n", {
                  flag: "a",
                  mode: 0o600,
                })
                .pipe(Effect.orDie);
            }
            const nextState: SubscriptionState = {
              loaded: true,
              records: kept,
              nextCursor: state.nextCursor + 1,
            };
            yield* Ref.update(states, (map) =>
              new Map(map).set(stateKey(projectId, subscription.name), nextState),
            );
            const item: EventHistoryItem = {
              projectId,
              subscription,
              record: toHistoryRecord(line),
            };
            yield* PubSub.publish(changes, item);
            return item.record;
          }),
        ),
      );

    const query: EventHistoryService["query"] = (projectId, name, input) =>
      semaphore.withPermit(
        provide(
          Effect.gen(function* () {
            const current = yield* Ref.get(registrations);
            const registration = current.get(projectId);
            const subscription = yield* subscriptionOf(projectId, name);
            if (
              registration === undefined ||
              subscription === undefined ||
              subscription.policy === false
            ) {
              return [];
            }
            const state = yield* stateFor(registration, subscription);
            const now = Date.now();
            const records = retained(state.records, subscription.policy, now).map(toHistoryRecord);
            const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
            const end =
              input.before === undefined
                ? records.length
                : records.findIndex((record) => record.cursor === input.before);
            const slice = records.slice(0, end === -1 ? records.length : end);
            return slice.slice(Math.max(0, slice.length - limit)).reverse();
          }),
        ),
      );

    const replay: EventHistoryService["replay"] = (projectId, filter) =>
      provide(
        Effect.gen(function* () {
          const current = yield* Ref.get(registrations);
          const registration = current.get(projectId);
          if (registration === undefined) return [];
          const items: Array<EventHistoryItem> = [];
          for (const subscription of registration.subscriptions) {
            if (subscription.policy === false || !matches(subscription, filter)) continue;
            const records = yield* query(projectId, subscription.name, { limit: 500 });
            for (const record of records) {
              items.push({ projectId, subscription, record });
            }
          }
          const after = filter?.afterCursor;
          const filtered =
            after === undefined
              ? items
              : items.filter((item) => cursorNumber(item.record.cursor) > cursorNumber(after));
          const limit = filter?.limit;
          const sorted = filtered.sort((left, right) => left.record.receivedAt - right.record.receivedAt);
          return limit === undefined ? sorted : sorted.slice(Math.max(0, sorted.length - limit));
        }),
      );

    const live: EventHistoryService["live"] = (projectId, filter) =>
      Stream.fromPubSub(changes).pipe(
        Stream.filter(
          (item) =>
            item.projectId === projectId && matches(item.subscription, filter),
        ),
      );

    return {
      register,
      unregister,
      subscriptions: (projectId) =>
        Ref.get(registrations).pipe(
          Effect.map((current) => current.get(projectId)?.subscriptions ?? []),
        ),
      record,
      query,
      replay,
      live,
    };
  }),
);

/** Map one manifest topic to a history subscription. */
export const historySubscription = (topic: {
  readonly name: string;
  readonly integration: string;
  readonly slot: string;
  readonly topic: string;
  readonly history?: HistoryPolicy | false | undefined;
  readonly schemaFingerprint?: string | undefined;
}): EventHistorySubscription => ({
  name: topic.name,
  integration: topic.integration,
  slot: topic.slot,
  topic: topic.topic,
  policy: topic.history ?? { maxEntries: 1000, retentionMs: 7 * 24 * 60 * 60 * 1_000 },
  fingerprint: topic.schemaFingerprint ?? "",
});

/** Register every topic a project's manifest declares. */
export const historyRegistration = (
  project: ProjectRecord,
  scriptId: string,
  topics: ReadonlyArray<{
    readonly name: string;
    readonly integration: string;
    readonly slot: string;
    readonly topic: string;
    readonly history?: HistoryPolicy | false | undefined;
    readonly schemaFingerprint?: string | undefined;
  }>,
): EventHistoryRegistration => ({
  projectId: project.id,
  scriptId,
  root: project.root,
  subscriptions: topics.map(historySubscription),
});
