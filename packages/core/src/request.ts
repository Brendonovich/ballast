import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Schema } from "effect";
import type { ConnectionRequestError } from "./errors.ts";
import type { RequestManifest } from "./manifest.ts";
import { Runtime } from "./runtime.ts";
import { ManifestRecorder, RequestClients } from "./services.ts";
import type { ManifestRecorderService, RequestClientsService } from "./services.ts";

export interface RequestRef<A, B> {
  readonly integration: string;
  readonly slot: string;
  /** The request name, e.g. `fake/echo`. */
  readonly request: string;
  readonly scopes: ReadonlyArray<string>;
  /** Client key: `integration/slot/request`. */
  readonly key: string;
  readonly inputSchema?: Schema.Codec<A, unknown, never, never>;
  readonly outputSchema?: Schema.Codec<B, unknown, never, never>;
}

export interface RequestSpec<A, B> {
  readonly integration: string;
  readonly slot: string;
  readonly request: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly inputSchema?: Schema.Codec<A, unknown, never, never>;
  readonly outputSchema?: Schema.Codec<B, unknown, never, never>;
}

export type RequestClient<A, B> = (
  input: A,
) => Effect.Effect<B, ConnectionRequestError, Runtime>;

export const toRequestManifest = (request: RequestRef<unknown, unknown>): RequestManifest => ({
  integration: request.integration,
  slot: request.slot,
  request: request.request,
  scopes: [...request.scopes],
});

export interface RequestHostService {
  /** Declare a request and acquire its client (Fake's one-declaration-per-request style). */
  readonly client: <A, B>(request: RequestRef<A, B>) => Effect.Effect<RequestClient<A, B>>;
  /**
   * Acquire a client for a request already granted by the connection (for
   * example `obs/*`). Plan mode records nothing and returns a client that dies
   * if called; runtime mode returns the real client.
   */
  readonly granted: <A, B>(request: RequestRef<A, B>) => RequestClient<A, B>;
}

/**
 * The host service request capabilities acquire clients from. The plan layer
 * records the request and hands back a client that dies if it is ever called;
 * the runtime layer asks the agent for the real client.
 */
export class RequestHost extends Context.Service<RequestHost, RequestHostService>()("Ballast/RequestHost") {}

export class RequestCalledDuringPlanError extends Error {
  readonly request: string;
  readonly slot: string;

  constructor(request: string, slot: string) {
    super(
      `Request "${request}" on slot "${slot}" was called during plan. Init must declare requests, not call them.`,
    );
    this.name = "RequestCalledDuringPlanError";
    this.request = request;
    this.slot = slot;
  }
}

const planClient = <A, B>(request: RequestRef<A, B>): RequestClient<A, B> => () =>
  Effect.die(new RequestCalledDuringPlanError(request.request, request.slot));

const runtimeClient = <A, B>(
  clients: Option.Option<RequestClientsService>,
  request: RequestRef<A, B>,
): Effect.Effect<RequestClient<A, B>> =>
  Option.match(clients, {
    onNone: () =>
      Effect.die(new Error(`Request "${request.request}" was used without a RequestClients service`)),
    onSome: (service) => service.client(request),
  });

/**
 * Plan-phase host service: `client` records the request and returns a client
 * that dies; `granted` records nothing (the connection already declared its
 * request namespace) and also returns a dying client.
 */
export const RequestHostPlan: Layer.Layer<RequestHost> = Layer.effect(
  RequestHost,
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(ManifestRecorder);

    return RequestHost.of({
      client: (request) =>
        Option.match(recorder, {
          onNone: () =>
            Effect.die(
              new Error("RequestHost.client was called in plan phase without a ManifestRecorder"),
            ),
          onSome: (service: ManifestRecorderService) =>
            service.request(toRequestManifest(request)).pipe(Effect.as(planClient(request))),
        }),
      granted: (request) => planClient(request),
    });
  }),
);

/** Runtime host service: request calls go over the runtime RPC client. */
export const RequestHostRuntime: Layer.Layer<RequestHost> = Layer.effect(
  RequestHost,
  Effect.gen(function* () {
    const clients = yield* Effect.serviceOption(RequestClients);

    return RequestHost.of({
      client: (request) => runtimeClient(clients, request),
      granted: (request) => (input) =>
        Effect.flatMap(runtimeClient(clients, request), (client) => client(input)),
    });
  }),
);

/**
 * Declare a request capability and acquire its typed client. Must be yielded
 * during init; the plan phase records it and returns a client that dies if
 * called.
 */
export const Request = <A, B>(
  spec: RequestSpec<A, B>,
): Effect.Effect<RequestClient<A, B>, never, RequestHost> => {
  const ref: RequestRef<A, B> = {
    integration: spec.integration,
    slot: spec.slot,
    request: spec.request,
    scopes: spec.scopes ?? [],
    key: `${spec.integration}/${spec.slot}/${spec.request}`,
    ...(spec.inputSchema === undefined ? {} : { inputSchema: spec.inputSchema }),
    ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
  };

  return Effect.flatMap(RequestHost, (host) => host.client(ref));
};
