import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  EventRecord,
  LogEntry,
  LogLevel,
  LogSource,
  ServiceEvent,
  UnitKind,
} from "@ballast/agent-protocol";
import type { RuntimeSession } from "../runtime-session.ts";
import { EventHistory } from "./event-history.ts";

const MAX_LOGS = 2_000;
const MAX_EVENTS = 2_000;

export interface LogInput {
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly message: string;
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly unitKind?: UnitKind;
  readonly unitName?: string;
  readonly fields?: unknown;
}

export interface LogFilter {
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly unitKind?: UnitKind;
  readonly unitName?: string;
  readonly levels?: ReadonlyArray<LogLevel>;
  readonly afterSeq?: number;
  readonly limit?: number;
}

/**
 * Record a JSON-safe copy of a payload. Service events are often decoded
 * schemas (Twitch timestamps become `Date`) and webhook deliveries contain
 * bytes, neither of which `Schema.Json` accepts directly. JSON.stringify
 * turns Dates into ISO strings and skips undefined/function values; the
 * replacer keeps bigints and cycles from throwing.
 */
const jsonValue = (value: unknown): Schema.Json => {
  const convert = (entry: unknown, stack: WeakSet<object>): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      return entry;
    }
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : null;
    if (typeof entry === "bigint") return entry.toString();
    if (typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol") {
      return undefined;
    }
    if (entry instanceof Date) return entry.toISOString();
    if (entry instanceof Uint8Array) return Array.from(entry);
    if (Array.isArray(entry)) return entry.map((item) => convert(item, stack) ?? null);
    if (typeof entry === "object") {
      if (stack.has(entry)) return "[Circular]";
      stack.add(entry);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(entry)) {
        const converted = convert(item, stack);
        if (converted !== undefined) output[key] = converted;
      }
      stack.delete(entry);
      return output;
    }
    return undefined;
  };
  const decoded = Schema.decodeUnknownOption(Schema.Json)(convert(value, new WeakSet()));
  return decoded._tag === "Some" ? decoded.value : {};
};

const messageOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

interface LogState {
  readonly entries: ReadonlyArray<LogEntry>;
  readonly nextSeq: number;
}

interface LogStoreService {
  readonly write: (input: LogInput) => Effect.Effect<LogEntry>;
  readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>;
  readonly lastSeq: Effect.Effect<number>;
  readonly stream: (filter: LogFilter) => Stream.Stream<LogEntry>;
}

export class Logs extends Context.Service<Logs, LogStoreService>()("ballast/service/Logs") {}

const logMatches = (filter: LogFilter, entry: LogEntry): boolean =>
  (filter.projectId === undefined || entry.projectId === filter.projectId) &&
  (filter.scriptId === undefined || entry.scriptId === filter.scriptId) &&
  (filter.unitKind === undefined || entry.unitKind === filter.unitKind) &&
  (filter.unitName === undefined || entry.unitName === filter.unitName) &&
  (filter.levels === undefined || filter.levels.includes(entry.level));

export const LogsLive = Layer.effect(
  Logs,
  Effect.gen(function* () {
    const state = yield* Ref.make<LogState>({ entries: [], nextSeq: 1 });
    const changes = yield* PubSub.unbounded<LogEntry>();

    const write = (input: LogInput): Effect.Effect<LogEntry> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const entry: LogEntry = {
          seq: current.nextSeq,
          at: Date.now(),
          level: input.level,
          source: input.source,
          message: input.message,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
          ...(input.unitKind === undefined ? {} : { unitKind: input.unitKind }),
          ...(input.unitName === undefined ? {} : { unitName: input.unitName }),
          ...(input.fields === undefined ? {} : { fields: jsonValue(input.fields) }),
        };
        const entries = [...current.entries, entry].slice(-MAX_LOGS);
        yield* Ref.set(state, { entries, nextSeq: current.nextSeq + 1 });
        yield* PubSub.publish(changes, entry);
        return entry;
      });

    return {
      write,
      entries: Effect.map(Ref.get(state), (current) => current.entries),
      lastSeq: Effect.map(Ref.get(state), (current) => current.nextSeq - 1),
      stream: (filter) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the buffer so nothing written in between is lost.
            const subscription = yield* PubSub.subscribe(changes);
            const current = yield* Ref.get(state);
            const buffered = current.entries.filter(
              (entry) =>
                entry.seq > (filter.afterSeq ?? 0) && logMatches(filter, entry),
            );
            const replay =
              filter.limit === undefined ? buffered : buffered.slice(-filter.limit);
            const replayedThrough = current.nextSeq - 1;
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (entry) => entry.seq > replayedThrough && logMatches(filter, entry),
                ),
              ),
            );
          }),
        ),
    };
  }),
);

export interface EventInput {
  readonly id?: string;
  /** Original receive time; defaults to now. Hydration uses this. */
  readonly at?: number;
  readonly direction: "inbound" | "outbound";
  readonly integration: string;
  readonly topic: string;
  readonly connectionId?: string;
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly unitKind?: UnitKind;
  readonly unitName?: string;
  readonly payload: unknown;
  readonly stale?: boolean;
  readonly dropped?: boolean;
  readonly request?: string;
}

export interface EventFilter {
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly unitKind?: UnitKind;
  readonly unitName?: string;
  readonly integration?: string;
  readonly topic?: string;
  readonly afterSeq?: number;
  readonly limit?: number;
}

interface EventState {
  readonly entries: ReadonlyArray<EventRecord>;
  readonly nextSeq: number;
}

interface EventLogService {
  readonly record: (input: EventInput) => Effect.Effect<EventRecord>;
  readonly entries: Effect.Effect<ReadonlyArray<EventRecord>>;
  readonly lastSeq: Effect.Effect<number>;
  readonly stream: (filter: EventFilter) => Stream.Stream<EventRecord>;
}

export class EventLog extends Context.Service<EventLog, EventLogService>()(
  "ballast/service/EventLog",
) {}

const eventMatches = (filter: EventFilter, entry: EventRecord): boolean =>
  (filter.projectId === undefined || entry.projectId === filter.projectId) &&
  (filter.scriptId === undefined || entry.scriptId === filter.scriptId) &&
  (filter.unitKind === undefined || entry.unitKind === filter.unitKind) &&
  (filter.unitName === undefined || entry.unitName === filter.unitName) &&
  (filter.integration === undefined || entry.integration === filter.integration) &&
  (filter.topic === undefined || entry.topic === filter.topic);

export const EventLogLive = Layer.effect(
  EventLog,
  Effect.gen(function* () {
    const state = yield* Ref.make<EventState>({ entries: [], nextSeq: 1 });
    const changes = yield* PubSub.unbounded<EventRecord>();

    const record = (input: EventInput): Effect.Effect<EventRecord> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const id = input.id ??
          `${input.integration}:${globalThis.crypto.randomUUID()}`;
        const entry: EventRecord = {
          seq: current.nextSeq,
          id,
          at: input.at ?? Date.now(),
          direction: input.direction,
          integration: input.integration,
          topic: input.topic,
          payload: jsonValue(input.payload),
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
          ...(input.unitKind === undefined ? {} : { unitKind: input.unitKind }),
          ...(input.unitName === undefined ? {} : { unitName: input.unitName }),
          ...(input.stale === undefined ? {} : { stale: input.stale }),
          ...(input.dropped === undefined ? {} : { dropped: input.dropped }),
          ...(input.request === undefined ? {} : { request: input.request }),
        };
        const entries = [...current.entries, entry].slice(-MAX_EVENTS);
        yield* Ref.set(state, { entries, nextSeq: current.nextSeq + 1 });
        yield* PubSub.publish(changes, entry);
        return entry;
      });

    return {
      record,
      entries: Effect.map(Ref.get(state), (current) => current.entries),
      lastSeq: Effect.map(Ref.get(state), (current) => current.nextSeq - 1),
      stream: (filter) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the buffer so nothing written in between is lost.
            const subscription = yield* PubSub.subscribe(changes);
            const current = yield* Ref.get(state);
            const buffered = current.entries.filter(
              (entry) =>
                entry.seq > (filter.afterSeq ?? 0) && eventMatches(filter, entry),
            );
            const replay =
              filter.limit === undefined ? buffered : buffered.slice(-filter.limit);
            const replayedThrough = current.nextSeq - 1;
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (entry) => entry.seq > replayedThrough && eventMatches(filter, entry),
                ),
              ),
            );
          }),
        ),
    };
  }),
);

export interface ActiveSession {
  readonly session: RuntimeSession;
  readonly projectId: string;
  readonly scriptId: string;
}

interface SessionEntry {
  readonly session: RuntimeSession;
  readonly projectId: string;
  readonly scriptId: string;
  /** "integration/slot" -> connection instance id. */
  readonly bindings?: ReadonlyMap<string, string>;
  /** Project-mode topic key -> declared unit name, for unit-filtered events. */
  readonly unitNames?: ReadonlyMap<string, string>;
}

export interface InboundEvent {
  readonly integration: string;
  readonly slot: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly connectionId?: string;
  readonly eventId?: string;
  readonly stale?: boolean;
  /** Explicit agent-bus key (hotkeys embed condition data in it). */
  readonly key?: string;
}

interface PendingEntry {
  readonly projectId: string;
  readonly scriptId: string;
  readonly subscriptions: ReadonlySet<string>;
  readonly bindings?: ReadonlyMap<string, string>;
  readonly events: ReadonlyArray<{
    readonly key: string;
    readonly input: InboundEvent;
  }>;
}

interface EventRouterService {
  readonly register: (entry: SessionEntry) => Effect.Effect<void>;
  readonly unregister: (key: string) => Effect.Effect<void>;
  /**
   * Announce the subscriptions a starting generation will register before
   * its connection drivers run. Events that arrive before `register` are held
   * here, deterministically, instead of being dropped. Call
   * `cancelExpected` when the start fails.
   */
  readonly expectSubscriptions: (entry: {
    readonly projectId: string;
    readonly scriptId: string;
    readonly subscriptions: ReadonlyArray<string>;
    readonly bindings?: ReadonlyMap<string, string>;
  }) => Effect.Effect<void>;
  readonly cancelExpected: (entry: {
    readonly projectId: string;
    readonly scriptId: string;
  }) => Effect.Effect<void>;
  /** Hold unmatched events until subscriptions from startup are registered. */
  readonly beginWarmup: Effect.Effect<void>;
  /** Stop holding unmatched startup events; buffered ones remain available. */
  readonly finishWarmup: Effect.Effect<void>;
  readonly publishInbound: (input: InboundEvent) => Effect.Effect<void>;
  readonly recordOutbound: (input: {
    readonly projectId: string;
    readonly scriptId: string;
    readonly integration: string;
    readonly slot: string;
    readonly request: string;
    readonly input: unknown;
    readonly output?: unknown;
  }) => Effect.Effect<void>;
}

export class EventRouter extends Context.Service<EventRouter, EventRouterService>()(
  "ballast/service/EventRouter",
) {}

const MAX_PENDING_EVENTS = 1_000;

export const EventRouterLive = Layer.effect(
  EventRouter,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<ReadonlyMap<string, SessionEntry>>(new Map());
    const pending = yield* Ref.make<ReadonlyMap<string, PendingEntry>>(new Map());
    const warming = yield* Ref.make(false);
    const startup = yield* Ref.make<
      ReadonlyArray<{ readonly key: string; readonly input: InboundEvent }>
    >([]);
    const semaphore = yield* Semaphore.make(1);
    const events = yield* EventLog;
    const history = yield* EventHistory;

    const keyOf = (projectId: string, scriptId: string): string =>
      `${projectId}\u0000${scriptId}`;
    const eventKey = (input: InboundEvent): string =>
      input.key ?? `${input.integration}/${input.slot}/${input.topic}`;

    const recordDropped = (input: InboundEvent): Effect.Effect<void> =>
      events.record({
        ...(input.eventId === undefined ? {} : { id: input.eventId }),
        direction: "inbound",
        integration: input.integration,
        topic: input.topic,
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
        payload: input.payload,
        dropped: true,
        ...(input.stale === undefined ? {} : { stale: input.stale }),
      });

    const recordDelivered = (
      entry: SessionEntry,
      key: string,
      input: InboundEvent,
    ): Effect.Effect<void> => {
      const unitName = entry.unitNames?.get(key) ?? entry.unitNames?.get(input.key ?? "");
      return events.record({
        ...(input.eventId === undefined ? {} : { id: input.eventId }),
        direction: "inbound",
        integration: input.integration,
        topic: input.topic,
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
        projectId: entry.projectId,
        scriptId: entry.scriptId,
        ...(unitName === undefined ? {} : { unitKind: "topic" as const, unitName }),
        payload: input.payload,
        ...(input.stale === undefined ? {} : { stale: input.stale }),
        dropped: false,
      });
    };

    const matchKeys = (
      subscriptions: ReadonlySet<string>,
      bindings: ReadonlyMap<string, string> | undefined,
      input: InboundEvent,
    ): ReadonlyArray<string> => {
      if (input.connectionId !== undefined && bindings !== undefined) {
        const keys: Array<string> = [];
        for (const [requirement, instanceId] of bindings) {
          if (instanceId !== input.connectionId) continue;
          const index = requirement.indexOf("/");
          if (index <= 0) continue;
          const key = requirement + "/" + input.topic;
          if (subscriptions.has(key)) keys.push(key);
        }
        if (keys.length > 0) return keys;
      }
      const fallback = `${input.integration}/${input.slot}/${input.topic}`;
      return subscriptions.has(fallback) ? [fallback] : [];
    };

    /** Persist before delivery so a reload never loses a subscribed event. */
    const recordHistory = (
      projectId: string,
      keys: ReadonlyArray<string>,
      input: InboundEvent,
    ): Effect.Effect<void> =>
      Effect.forEach(
        keys,
        (key) => history.record(projectId, key, jsonValue(input.payload)),
        { discard: true },
      );

    const deliver = (
      entry: SessionEntry,
      key: string,
      input: InboundEvent,
    ): Effect.Effect<void> =>
      Effect.sync(() => entry.session.deliver(key, input.payload)).pipe(
        Effect.andThen(recordDelivered(entry, key, input)),
      );

    const expectSubscriptions: EventRouterService["expectSubscriptions"] = (entry) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          if (entry.subscriptions.length === 0) return;
          const key = keyOf(entry.projectId, entry.scriptId);
          const subscriptions = new Set(entry.subscriptions);
          const existing = (yield* Ref.get(pending)).get(key);
          const events =
            existing !== undefined
              ? existing.events
              : (yield* Ref.get(warming))
                ? (yield* Ref.get(startup)).flatMap((event) => {
                    const keys = matchKeys(subscriptions, entry.bindings, event.input);
                    return keys.length === 0
                      ? []
                      : [{ key: keys[0] ?? event.key, input: event.input }];
                  })
                : [];
          if (existing === undefined) {
            yield* Effect.forEach(
              events,
              (event) => recordHistory(entry.projectId, [event.key], event.input),
              { discard: true },
            );
          }
          const next: PendingEntry = {
            projectId: entry.projectId,
            scriptId: entry.scriptId,
            subscriptions,
            ...(entry.bindings === undefined ? {} : { bindings: entry.bindings }),
            events,
          };
          yield* Ref.update(pending, (current) => {
            const map = new Map(current);
            map.set(key, next);
            return map;
          });
        }),
      );

    const cancelExpected: EventRouterService["cancelExpected"] = (entry) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const key = keyOf(entry.projectId, entry.scriptId);
          const current = yield* Ref.get(pending);
          const discarded = current.get(key);
          if (discarded === undefined) return;
          yield* Ref.update(pending, (map) => {
            const next = new Map(map);
            next.delete(key);
            return next;
          });
          for (const buffered of discarded.events) {
            yield* recordDropped(buffered.input);
          }
        }),
      );

    const register: EventRouterService["register"] = (entry) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const key = keyOf(entry.projectId, entry.scriptId);
          const currentPending = yield* Ref.get(pending);
          const buffered = currentPending.get(key);
          yield* Ref.update(pending, (current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.set(key, entry);
            return next;
          });
          if (buffered === undefined) return;
          for (const event of buffered.events) {
            const keys = matchKeys(entry.session.subscriptions, entry.bindings, event.input);
            if (keys.length === 0) {
              yield* recordDropped(event.input);
              continue;
            }
            for (const key of keys) {
              yield* deliver(entry, key, event.input);
            }
          }
        }),
      );

    const unregister: EventRouterService["unregister"] = (key) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const currentPending = yield* Ref.get(pending);
          const discarded = currentPending.get(key);
          yield* Ref.update(pending, (current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          yield* Ref.update(sessions, (current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          if (discarded !== undefined) {
            for (const event of discarded.events) {
              yield* recordDropped(event.input);
            }
          }
        }),
      );

    const publishInbound: EventRouterService["publishInbound"] = (input) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const key = eventKey(input);
          const current = yield* Ref.get(sessions);
          const matched = [...current.values()].flatMap((entry) =>
            matchKeys(entry.session.subscriptions, entry.bindings, input).map((matchedKey) => ({
              entry,
              key: matchedKey,
            })),
          );
          if (matched.length > 0) {
            yield* Effect.forEach(
              matched,
              (match) =>
                recordHistory(match.entry.projectId, [match.key], input).pipe(
                  Effect.andThen(deliver(match.entry, match.key, input)),
                ),
              { discard: true },
            );
            return;
          }

          const currentPending = yield* Ref.get(pending);
          const waiting = [...currentPending.values()].filter(
            (entry) => matchKeys(entry.subscriptions, entry.bindings, input).length > 0,
          );
          if (waiting.length > 0) {
            yield* Effect.forEach(
              waiting,
              (entry) => {
                const keys = matchKeys(entry.subscriptions, entry.bindings, input);
                return recordHistory(
                  entry.projectId,
                  keys.length === 0 ? [key] : keys,
                  input,
                );
              },
              { discard: true },
            );
            yield* Ref.update(pending, (currentMap) => {
              const next = new Map(currentMap);
              for (const entry of waiting) {
                const pk = keyOf(entry.projectId, entry.scriptId);
                const latest = next.get(pk);
                if (latest === undefined) continue;
                if (latest.events.length >= MAX_PENDING_EVENTS) continue;
                next.set(pk, {
                  ...latest,
                  events: [...latest.events, { key, input }],
                });
              }
              return next;
            });
            return;
          }

          if (yield* Ref.get(warming)) {
            yield* Ref.update(startup, (current) =>
              current.length >= MAX_PENDING_EVENTS
                ? current
                : [...current, { key, input }],
            );
            return;
          }
          yield* recordDropped(input);
        }),
      );

    const beginWarmup: EventRouterService["beginWarmup"] =
      semaphore.withPermit(
        Effect.gen(function* () {
          yield* Ref.set(warming, true);
          yield* Ref.set(startup, []);
        }),
      );

    const finishWarmup: EventRouterService["finishWarmup"] =
      semaphore.withPermit(
        Effect.gen(function* () {
          yield* Ref.set(warming, false);
          yield* Ref.set(startup, []);
        }),
      );

    return {
      register,
      unregister,
      expectSubscriptions,
      cancelExpected,
      beginWarmup,
      finishWarmup,
      publishInbound,
      recordOutbound: (input) =>
        events
          .record({
            direction: "outbound",
            integration: input.integration,
            topic: input.request.startsWith(`${input.integration}/`)
              ? input.request
              : `${input.integration}/${input.request}`,
            connectionId: `${input.integration}/${input.slot}`,
            projectId: input.projectId,
            scriptId: input.scriptId,
            request: input.request,
            payload: input.input,
          })
          .pipe(Effect.asVoid),
    };
  }),
);

interface HubService {
  readonly changes: PubSub.PubSub<ServiceEvent>;
  readonly publish: (event: ServiceEvent) => Effect.Effect<void>;
}

export class ServiceHub extends Context.Service<ServiceHub, HubService>()(
  "ballast/service/ServiceHub",
) {}

export const ServiceHubLive = Layer.effect(
  ServiceHub,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ServiceEvent>();
    return {
      changes,
      publish: (event) => PubSub.publish(changes, event).pipe(Effect.asVoid),
    };
  }),
);

export const logErrorMessage = (cause: unknown): string => messageOf(cause);
