import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type {
  EventRecord,
  LogEntry,
  LogLevel,
  LogSource,
  ServiceEvent,
} from "@ballast/agent-protocol";
import type { RuntimeSession } from "../runtime-session.ts";

const MAX_LOGS = 2_000;
const MAX_EVENTS = 2_000;

export interface LogInput {
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly message: string;
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly fields?: unknown;
}

export interface LogFilter {
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly levels?: ReadonlyArray<LogLevel>;
  readonly afterSeq?: number;
  readonly limit?: number;
}

const jsonValue = (value: unknown): Schema.Json => {
  const decoded = Schema.decodeUnknownOption(Schema.Json)(value);
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
          Effect.map(Ref.get(state), (current) => {
            const buffered = current.entries.filter(
              (entry) =>
                entry.seq > (filter.afterSeq ?? 0) && logMatches(filter, entry),
            );
            const replay =
              filter.limit === undefined ? buffered : buffered.slice(-filter.limit);
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromPubSub(changes).pipe(
                Stream.filter((entry) => logMatches(filter, entry)),
              ),
            );
          }),
        ),
    };
  }),
);

export interface EventInput {
  readonly id?: string;
  readonly direction: "inbound" | "outbound";
  readonly integration: string;
  readonly topic: string;
  readonly connectionId?: string;
  readonly projectId?: string;
  readonly scriptId?: string;
  readonly payload: unknown;
  readonly stale?: boolean;
  readonly dropped?: boolean;
  readonly request?: string;
}

export interface EventFilter {
  readonly projectId?: string;
  readonly scriptId?: string;
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
        const entry: EventRecord = {
          seq: current.nextSeq,
          id: input.id ?? `${input.integration}:${randomUUID()}`,
          at: Date.now(),
          direction: input.direction,
          integration: input.integration,
          topic: input.topic,
          payload: jsonValue(input.payload),
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
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
          Effect.map(Ref.get(state), (current) => {
            const buffered = current.entries.filter(
              (entry) =>
                entry.seq > (filter.afterSeq ?? 0) && eventMatches(filter, entry),
            );
            const replay =
              filter.limit === undefined ? buffered : buffered.slice(-filter.limit);
            return Stream.concat(
              Stream.fromIterable(replay),
              Stream.fromPubSub(changes).pipe(
                Stream.filter((entry) => eventMatches(filter, entry)),
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
}

interface EventRouterService {
  readonly register: (entry: SessionEntry) => Effect.Effect<void>;
  readonly unregister: (key: string) => Effect.Effect<void>;
  readonly publishInbound: (input: {
    readonly integration: string;
    readonly slot: string;
    readonly topic: string;
    readonly payload: unknown;
    readonly connectionId?: string;
    readonly eventId?: string;
    readonly stale?: boolean;
    /** Explicit agent-bus key (hotkeys embed condition data in it). */
    readonly key?: string;
  }) => Effect.Effect<void>;
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

export const EventRouterLive = Layer.effect(
  EventRouter,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<ReadonlyMap<string, SessionEntry>>(new Map());
    const events = yield* EventLog;

    const register = (entry: SessionEntry): Effect.Effect<void> =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.set(`${entry.projectId}\u0000${entry.scriptId}`, entry);
        return next;
      });

    const unregister = (key: string): Effect.Effect<void> =>
      Ref.update(sessions, (current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });

    const publishInbound = (input: {
      readonly integration: string;
      readonly slot: string;
      readonly topic: string;
      readonly payload: unknown;
      readonly connectionId?: string;
      readonly eventId?: string;
      readonly stale?: boolean;
      readonly key?: string;
    }): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(sessions);
        const key = input.key ?? `${input.integration}/${input.slot}/${input.topic}`;
        const matched = [...current.values()].filter((entry) =>
          entry.session.subscriptions.has(key),
        );
        if (matched.length === 0) {
          yield* events.record({
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
          return;
        }
        yield* Effect.forEach(
          matched,
          (entry) =>
            Effect.gen(function* () {
              entry.session.deliver(key, input.payload);
              yield* events.record({
                ...(input.eventId === undefined ? {} : { id: input.eventId }),
                direction: "inbound",
                integration: input.integration,
                topic: input.topic,
                ...(input.connectionId === undefined
                  ? {}
                  : { connectionId: input.connectionId }),
                projectId: entry.projectId,
                scriptId: entry.scriptId,
                payload: input.payload,
                ...(input.stale === undefined ? {} : { stale: input.stale }),
                dropped: false,
              });
            }),
          { discard: true },
        );
      });

    return {
      register,
      unregister,
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
