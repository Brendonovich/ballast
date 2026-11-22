import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Schema } from "effect";
import type { ConnectionRef } from "./connection.ts";
import type { OnStale, TopicCondition, TopicManifest } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { EventBus, ManifestRecorder } from "./services.ts";
import type { EventBusService, ManifestRecorderService } from "./services.ts";

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
  readonly schema?: Schema.Schema<A>;
  /**
   * Resolved transport subscription parameters, when the topic has any. Set by
   * `subscribe` from the integration's `condition` builder, so the recorder
   * can put it in the manifest without knowing the topic's options.
   */
  readonly condition?: TopicCondition;
  /** Bus key: `integration/slot/topic`. */
  readonly key: (connection: ConnectionRef<Integration>) => string;
}

export interface Topic<
  A,
  Integration extends string = string,
  Options = void,
> extends TopicMetadata<A, Integration> {
  /**
   * Subscribe to this topic on a connection from the same integration. The
   * handler payload is inferred from the topic's schema. Integrations that
   * need provider-side filters (for example a Twitch reward id) accept them as
   * the third argument and turn them into manifest `condition` entries.
   */
  readonly subscribe: (
    connection: ConnectionRef<Integration>,
    handler: (event: A) => Effect.Effect<void, never, never>,
    options?: Options,
  ) => Effect.Effect<void, never, EventHost>;
}

export interface TopicSpec<A, Integration extends string = string, Options = void> {
  readonly integration: Integration;
  /** The topic name, e.g. `fake/tick`. */
  readonly topic: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly onStale?: OnStale;
  readonly maxAgeMs?: number;
  readonly schema?: Schema.Schema<A>;
  /**
   * Build the transport subscription parameters from the connection and the
   * per-subscription options. Identity references use `{ slot }` so planning
   * stays offline.
   */
  readonly condition?: (
    connection: ConnectionRef<Integration>,
    options: Options | undefined,
  ) => TopicCondition | undefined;
}

export const DEFAULT_MAX_AGE_MS = 60_000;

/** Build a typed topic definition. Pure: no recorder or connection needed. */
export const Topic = <A, Integration extends string, Options = void>(
  spec: TopicSpec<A, Integration, Options>,
): Topic<A, Integration, Options> => {
  const metadata: TopicMetadata<A, Integration> = {
    integration: spec.integration,
    topic: spec.topic,
    scopes: spec.scopes ?? [],
    onStale: spec.onStale ?? "drop",
    maxAgeMs: spec.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    key: (connection) => `${spec.integration}/${connection.slot}/${spec.topic}`,
    ...(spec.schema === undefined ? {} : { schema: spec.schema }),
  };

  return {
    ...metadata,
    subscribe: (connection, handler, options) => {
      const condition = spec.condition?.(connection, options);
      const bound: TopicMetadata<A, Integration> =
        condition === undefined ? metadata : { ...metadata, condition };
      return Effect.flatMap(EventHost, (host) => host.subscribe(bound, connection, handler));
    },
  };
};

export const toTopicManifest = <A, Integration extends string>(
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
): TopicManifest => ({
  integration: topic.integration,
  slot: connection.slot,
  topic: topic.topic,
  scopes: [...topic.scopes],
  onStale: topic.onStale,
  maxAgeMs: topic.maxAgeMs,
  ...(topic.condition === undefined ? {} : { condition: topic.condition }),
});

export interface EventHostService {
  readonly subscribe: <A, Integration extends string>(
    topic: TopicMetadata<A, Integration>,
    connection: ConnectionRef<Integration>,
    handler: (event: A) => Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
}

/**
 * The host service event sources register with. Plan mode records the topic;
 * runtime mode registers the handler with the agent's event bus.
 */
export class EventHost extends Context.Service<EventHost, EventHostService>()("Ballast/EventHost") {}

const subscribeInPlan = <A, Integration extends string>(
  recorder: Option.Option<ManifestRecorderService>,
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
): Effect.Effect<void> =>
  Option.match(recorder, {
    onNone: () =>
      Effect.die(new Error("EventHost.subscribe was called in plan phase without a ManifestRecorder")),
    onSome: (service) => service.topic(toTopicManifest(topic, connection)),
  });

const subscribeAtRuntime = <A, Integration extends string>(
  bus: Option.Option<EventBusService>,
  topic: TopicMetadata<A, Integration>,
  connection: ConnectionRef<Integration>,
  handler: (event: A) => Effect.Effect<void, never, never>,
): Effect.Effect<void> =>
  Option.match(bus, {
    onNone: () => Effect.die(new Error("EventHost.subscribe was called at runtime without an EventBus")),
    onSome: (service) => service.subscribe(topic.key(connection), handler),
  });

export const EventHostLive: Layer.Layer<EventHost, never, never> = Layer.effect(
  EventHost,
  Effect.gen(function* () {
    const phase = yield* currentPhase;
    const recorder = yield* Effect.serviceOption(ManifestRecorder);
    const bus = yield* Effect.serviceOption(EventBus);

    const service: EventHostService = {
      subscribe: (topic, connection, handler) =>
        phase === "plan"
          ? subscribeInPlan(recorder, topic, connection)
          : subscribeAtRuntime(bus, topic, connection, handler),
    };

    return EventHost.of(service);
  }),
);
