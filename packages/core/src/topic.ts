import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ConnectionRef } from "./connection.ts";
import {
  DEFAULT_HISTORY_MAX_ENTRIES,
  DEFAULT_HISTORY_RETENTION_MS,
  type EventHistoryHostService,
  type HistoryEntry,
  type HistoryPolicy,
  type HistoryQuery,
  type HistoryRecord,
} from "./history-types.ts";
import { EventHistoryHost } from "./history.ts";
import type { OnStale, TopicCondition, TopicManifest } from "./manifest.ts";
import type { DeclarationSource } from "./source.ts";
import { captureSource } from "./source.ts";
import { withUnitHandler } from "./unit.ts";
import { provideRuntime, Runtime } from "./runtime.ts";
import { EventBus, ManifestRecorder } from "./services.ts";
import type { EventBusService, ManifestRecorderService } from "./services.ts";

export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  maxEntries: DEFAULT_HISTORY_MAX_ENTRIES,
  retentionMs: DEFAULT_HISTORY_RETENTION_MS,
};

export interface HistoryPolicyOptions {
  readonly maxEntries?: number;
  readonly retention?: Duration.Input;
}

export type HistorySetting = HistoryPolicyOptions | false;

export interface HistoryOptions {
  /** Override the topic's history policy; `false` disables it. */
  readonly history?: HistorySetting;
}

export type SubscribeOptions<Options> = Options & HistoryOptions;

export interface SubscriptionHistoryQuery extends HistoryQuery {
  readonly limit?: number;
}

export interface TopicSubscription<A> {
  readonly name: string;
  readonly history: HistoryPolicy | false;
  readonly fingerprint: string;
  /** Newest first. Legacy entries are filtered unless requested. */
  readonly query: (options?: SubscriptionHistoryQuery) => Effect.Effect<
    ReadonlyArray<HistoryEntry<A>>,
    never,
    Runtime
  >;
  /** New entries for this subscription. */
  readonly watch: () => Stream.Stream<HistoryEntry<A>, never, Runtime>;
}

export const resolveHistoryPolicy = (
  setting: HistorySetting | undefined,
): HistoryPolicy | false => {
  if (setting === undefined) return DEFAULT_HISTORY_POLICY;
  if (setting === false) return false;
  const maxEntries = setting.maxEntries ?? DEFAULT_HISTORY_POLICY.maxEntries;
  const retentionMs =
    setting.retention === undefined
      ? DEFAULT_HISTORY_POLICY.retentionMs
      : Duration.toMillis(Duration.fromInputUnsafe(setting.retention));
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    throw new Error("history.maxEntries must be a positive finite number");
  }
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error("history.retention must be a finite non-negative duration");
  }
  return { maxEntries, retentionMs };
};

/**
 * A topic declared by an integration, before it is bound to a connection
 * slot. The integration literal is part of the type so subscribing with a
 * connection from another integration is a type error.
 */
export interface TopicMetadata<A, Integration extends string = string> {
  readonly integration: Integration;
  /** The topic name, e.g. `fake/tick`. */
  readonly topic: string;
  readonly scopes: ReadonlyArray<string>;
  readonly onStale: OnStale;
  readonly maxAgeMs: number;
  /** Payload schema, when the integration has one. */
  readonly schema?: Schema.Codec<A, unknown, never, never>;
  /**
   * Resolved transport subscription parameters, when the topic has any. Set by
   * `subscribe` from the integration's `condition` builder, so the recorder
   * can put it in the manifest without knowing the topic's options.
   */
  readonly condition?: TopicCondition;
  /** Default subscription history policy. Individual subscriptions may override it. */
  readonly history: HistoryPolicy | false;
  /** Bus key: `integration/slot/topic`. */
  readonly key: (connection: ConnectionRef<Integration>) => string;
}

export interface Topic<
  A,
  Integration extends string = string,
  Options = {},
> extends TopicMetadata<A, Integration> {
  /**
   * Subscribe to this topic on a connection from the same integration. The
   * handler payload is inferred from the topic's schema. Integrations that
   * need provider-side filters (for example a Twitch reward id) accept them as
   * the third argument and turn them into manifest `condition` entries.
   */
  readonly subscribe: (
    name: string,
    connection: ConnectionRef<Integration>,
    handler: (event: A) => Effect.Effect<void, unknown, Runtime>,
    options?: SubscribeOptions<Options>,
  ) => Effect.Effect<TopicSubscription<A>, never, EventHost>;
}

export interface TopicSpec<
  A,
  Integration extends string = string,
  Options = {},
> {
  readonly integration: Integration;
  /** The topic name, e.g. `fake/tick`. */
  readonly topic: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly onStale?: OnStale;
  readonly maxAgeMs?: number;
  readonly schema?: Schema.Codec<A, unknown, never, never>;
  /**
   * Build the transport subscription parameters from the connection and the
   * per-subscription options. Identity references use `{ slot }` so planning
   * stays offline.
   */
  readonly condition?: (
    connection: ConnectionRef<Integration>,
    options: Options | undefined,
  ) => TopicCondition | undefined;
  /** Default subscription history policy. Defaults to 1000 entries / 7 days. */
  readonly history?: HistorySetting;
}

export const DEFAULT_MAX_AGE_MS = 60_000;

const schemaFingerprint = (schema: Schema.Codec<unknown, unknown, never, never> | undefined): string => {
  const document = Schema.toJsonSchemaDocument(schema ?? Schema.Void);
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
};

const historyHost = (): Effect.Effect<EventHistoryHostService> =>
  Effect.serviceOption(EventHistoryHost).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(
            new Error("Topic history was used without an EventHistoryHost service"),
          ),
        onSome: (host) => Effect.succeed(host),
      }),
    ),
  );

const decodeHistory = <A>(
  schema: Schema.Codec<A, unknown, never, never> | undefined,
  fingerprint: string,
  includeLegacy: boolean,
  record: HistoryRecord,
): HistoryEntry<A> | undefined => {
  if (schema !== undefined && record.fingerprint === fingerprint) {
    return {
      _tag: "Event",
      cursor: record.cursor,
      receivedAt: record.receivedAt,
      event: Schema.decodeUnknownSync(Schema.toCodecJson(schema))(record.event),
    };
  }
  return includeLegacy
    ? {
        _tag: "Legacy",
        cursor: record.cursor,
        receivedAt: record.receivedAt,
        raw: record.event,
        fingerprint: record.fingerprint,
      }
    : undefined;
};

const makeSubscription = <A>(
  name: string,
  schema: Schema.Codec<A, unknown, never, never> | undefined,
  history: HistoryPolicy | false,
  fingerprint: string,
): TopicSubscription<A> => {
  const query = (
    options: SubscriptionHistoryQuery = {},
  ): Effect.Effect<ReadonlyArray<HistoryEntry<A>>, never, Runtime> =>
    Effect.gen(function* () {
      yield* Runtime;
      if (history === false || schema === undefined) return [];
      const host = yield* historyHost();
      const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
      const records = yield* host.query({
        name,
        limit,
        ...(options.before === undefined ? {} : { before: options.before }),
      });
      const includeLegacy = options.includeLegacy === true;
      return records.flatMap((record) => {
        const entry = decodeHistory(schema, fingerprint, includeLegacy, record);
        return entry === undefined ? [] : [entry];
      });
    });
  const watch = (): Stream.Stream<HistoryEntry<A>, never, Runtime> => {
    if (history === false || schema === undefined) return Stream.empty;
    return Stream.fromEffect(
      Effect.gen(function* () {
        yield* Runtime;
        const host = yield* historyHost();
        return yield* host.watch(name);
      }),
    ).pipe(
      Stream.flatMap(Stream.fromPubSub),
      Stream.map((record) => decodeHistory(schema, fingerprint, true, record)),
      Stream.filter((entry): entry is HistoryEntry<A> => entry !== undefined),
    );
  };
  return { name, history, fingerprint, query, watch };
};

const encodeHistory = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  event: A,
): Schema.Json => Schema.encodeUnknownSync(Schema.toCodecJson(schema))(event);

export const topicSchemaFingerprint = schemaFingerprint;

export interface SubscribeTopicInput<A, Integration extends string> {
  readonly topic: TopicMetadata<A, Integration>;
  readonly connection: ConnectionRef<Integration>;
  readonly handler: (event: A) => Effect.Effect<void, unknown, Runtime>;
  readonly name: string;
  readonly source: DeclarationSource | undefined;
  readonly history: HistoryPolicy | false;
  readonly fingerprint: string;
  readonly schema: Schema.Codec<A, unknown, never, never> | undefined;
}

/** Shared subscription implementation for plain topics and custom topic wrappers. */
export const subscribeTopic = <A, Integration extends string>(
  input: SubscribeTopicInput<A, Integration>,
): Effect.Effect<TopicSubscription<A>, never, EventHost> =>
  Effect.gen(function* () {
    const historyHost = yield* Effect.serviceOption(EventHistoryHost);
    const host = yield* EventHost;
    yield* host.subscribe(
      input.topic,
      input.connection,
      withUnitHandler(input.name, (event) =>
        Effect.gen(function* () {
          if (
            input.history !== false &&
            input.schema !== undefined &&
            Option.isSome(historyHost)
          ) {
            yield* historyHost.value.record({
              name: input.name,
              fingerprint: input.fingerprint,
              event: encodeHistory(input.schema, event),
            });
          }
          yield* provideRuntime(input.handler(event));
        }),
      ),
      input.name,
      input.source,
      input.history,
      input.fingerprint,
    );
    return makeSubscription(input.name, input.schema, input.history, input.fingerprint);
  });

/** Build a typed topic definition. Pure: no recorder or connection needed. */
export const Topic = <
  A,
  Integration extends string,
  Options = {},
>(
  spec: TopicSpec<A, Integration, Options>,
): Topic<A, Integration, Options> => {
  const metadata: TopicMetadata<A, Integration> = {
    integration: spec.integration,
    topic: spec.topic,
    scopes: spec.scopes ?? [],
    onStale: spec.onStale ?? "drop",
    maxAgeMs: spec.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    history: resolveHistoryPolicy(spec.history),
    key: (connection) => `${spec.integration}/${connection.slot}/${spec.topic}`,
    ...(spec.schema === undefined ? {} : { schema: spec.schema }),
  };

  return {
    ...metadata,
    subscribe: (name, connection, handler, options) => {
      const condition = spec.condition?.(connection, options);
      const history = resolveHistoryPolicy(options?.history ?? spec.history);
      const fingerprint = schemaFingerprint(spec.schema);
      const bound: TopicMetadata<A, Integration> = {
        ...metadata,
        history,
        ...(condition === undefined ? {} : { condition }),
      };
      const source = captureSource(2);
      return subscribeTopic({
        topic: bound,
        connection,
        handler,
        name,
        source,
        history,
        fingerprint,
        schema: spec.schema,
      });
    },
  };
};

export const toTopicManifest = <A, Integration extends string>(
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
  name: string,
  source: DeclarationSource | undefined,
  history: HistoryPolicy | false,
  schemaFingerprint: string,
): TopicManifest => ({
  integration: topic.integration,
  slot: connection.slot,
  topic: topic.topic,
  name,
  ...(source === undefined ? {} : { source }),
  scopes: [...topic.scopes],
  onStale: topic.onStale,
  maxAgeMs: topic.maxAgeMs,
  history,
  schemaFingerprint,
  ...(topic.condition === undefined ? {} : { condition: topic.condition }),
});

export interface EventHostService {
  readonly subscribe: <A, Integration extends string>(
    topic: TopicMetadata<A, Integration>,
    connection: ConnectionRef<Integration>,
    handler: (event: A) => Effect.Effect<void, unknown, never>,
    name: string,
    source: DeclarationSource | undefined,
    history: HistoryPolicy | false,
    schemaFingerprint: string,
  ) => Effect.Effect<void>;
}

/**
 * The host service event sources register with. The plan layer records the
 * topic; the runtime layer registers the handler with the agent's event bus.
 */
export class EventHost extends Context.Service<EventHost, EventHostService>()("Ballast/EventHost") {}

const subscribeInPlan = <A, Integration extends string>(
  recorder: Option.Option<ManifestRecorderService>,
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
  name: string,
  source: DeclarationSource | undefined,
  history: HistoryPolicy | false,
  schemaFingerprint: string,
): Effect.Effect<void> =>
  Option.match(recorder, {
    onNone: () =>
      Effect.die(new Error("EventHost.subscribe was called in plan phase without a ManifestRecorder")),
    onSome: (service) =>
      service.topic(
        toTopicManifest(topic, connection, name, source, history, schemaFingerprint),
      ),
  });

const subscribeAtRuntime = <A, Integration extends string>(
  bus: Option.Option<EventBusService>,
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
  name: string,
  handler: (event: A) => Effect.Effect<void, unknown, never>,
): Effect.Effect<void> =>
  Option.match(bus, {
    onNone: () => Effect.die(new Error("EventHost.subscribe was called at runtime without an EventBus")),
    onSome: (service) => service.subscribe(topic.key(connection), name, handler),
  });

/**
 * Plan-phase host service: declarations go into the manifest recorder and
 * handlers are never registered or evaluated.
 */
export const EventHostPlan: Layer.Layer<EventHost> = Layer.effect(
  EventHost,
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(ManifestRecorder);

    return EventHost.of({
      subscribe: (topic, connection, _handler, name, source, history, schemaFingerprint) =>
        subscribeInPlan(
          recorder,
          topic,
          connection,
          name,
          source,
          history,
          schemaFingerprint,
        ),
    });
  }),
);

/**
 * Runtime host service: subscriptions go to the agent's event bus, which owns
 * delivery and gives each handler invocation its own scope.
 */
export const EventHostRuntime: Layer.Layer<EventHost> = Layer.effect(
  EventHost,
  Effect.gen(function* () {
    const bus = yield* Effect.serviceOption(EventBus);

    return EventHost.of({
      subscribe: (topic, connection, handler, name) =>
        subscribeAtRuntime(bus, topic, connection, name, handler),
    });
  }),
);
