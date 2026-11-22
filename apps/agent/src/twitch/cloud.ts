import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { WebSocket } from "ws";
import {
  ApiErrorBody,
  HelixResponse,
  ListConnectionsResponse,
  PairingClaimResponse,
  ReconcileSubscriptionsResponse,
  RelayServerMessage,
  TwitchTokenResponse,
  encodeRelayClientMessage,
} from "@ballast/cloud-protocol";
import type {
  HelixRequest as CloudHelixRequest,
  HelixResponse as CloudHelixResponse,
  RelayServerMessage as RelayMessage,
  TwitchConnection,
} from "@ballast/cloud-protocol";
import * as Twitch from "@ballast/module-twitch";

import { TwitchTransportError } from "./errors.ts";
import { twitchTopicType } from "./conditions.ts";
import type { TwitchIdentity, TwitchSubscriptionSpec, TwitchTransport } from "./transport.ts";
import { busTopic } from "./transport.ts";

const accessTokenMarginMs = 60_000;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const missingScopesFrom = (details: unknown): ReadonlyArray<string> | undefined => {
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Struct({ missing: Schema.Array(Schema.String) }))(details),
  );
  return parsed?.missing;
};

const apiError = (status: number, body: unknown): TwitchTransportError => {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ApiErrorBody)(body));
  if (parsed === undefined) {
    return new TwitchTransportError({
      reason: "Ballast cloud request failed (" + status + ")",
      status,
    });
  }
  const missing = parsed.error.tag === "missing_scopes"
    ? missingScopesFrom(parsed.error.details)
    : undefined;
  return new TwitchTransportError({
    reason: parsed.error.message,
    tag: parsed.error.tag,
    status,
    ...(missing === undefined ? {} : { missingScopes: missing }),
  });
};

export interface CloudApiOptions {
  readonly baseUrl: string;
  readonly machineToken: string;
}

export interface CloudApi {
  readonly baseUrl: string;
  readonly machineToken: string;
  readonly listConnections: Effect.Effect<ReadonlyArray<TwitchConnection>, TwitchTransportError>;
  readonly getToken: (connectionId: string) => Effect.Effect<
    Schema.Schema.Type<typeof TwitchTokenResponse>,
    TwitchTransportError
  >;
  readonly reconcile: (
    connectionId: string,
    specs: ReadonlyArray<TwitchSubscriptionSpec>,
  ) => Effect.Effect<void, TwitchTransportError>;
  readonly helix: (
    request: CloudHelixRequest,
  ) => Effect.Effect<CloudHelixResponse, TwitchTransportError>;
}

const readJson = (response: Response): Effect.Effect<unknown, TwitchTransportError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await response.text();
      return text.trim().length === 0 ? undefined : JSON.parse(text);
    },
    catch: (cause) =>
      new TwitchTransportError({
        reason: "Ballast cloud returned invalid JSON: " + errorMessage(cause),
        status: response.status,
      }),
  });

export interface ClaimPairingOptions {
  readonly url: string;
  readonly code: string;
  readonly machineName: string;
  readonly platform?: string;
}

/** \`ballast pair <code> --cloud <url>\`. */
export const claimPairing = (
  options: ClaimPairingOptions,
): Effect.Effect<Schema.Schema.Type<typeof PairingClaimResponse>, TwitchTransportError> =>
  Effect.gen(function* () {
    const baseUrl = options.url.replace(/\/$/, "");
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(baseUrl + "/api/pairing/claim", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            code: options.code,
            machineName: options.machineName,
            ...(options.platform === undefined ? {} : { platform: options.platform }),
          }),
        }),
      catch: (cause) =>
        new TwitchTransportError({
          reason: "Could not reach the Ballast cloud: " + errorMessage(cause),
        }),
    });
    const json = yield* readJson(response);
    if (!response.ok) return yield* apiError(response.status, json);
    return yield* Schema.decodeUnknownEffect(PairingClaimResponse)(json).pipe(
      Effect.mapError(
        (cause) =>
          new TwitchTransportError({
            reason: "The cloud returned an invalid pairing response: " + cause.message,
          }),
      ),
    );
  });

/**
 * Typed JSON client for the cloud gateway. The MVP routes are plain HTTP
 * (decision 0002); the relay is a separate WebSocket.
 */
export const makeCloudApi = (options: CloudApiOptions): CloudApi => {
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  const call = (
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Effect.Effect<unknown, TwitchTransportError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(baseUrl + path, {
            method,
            headers: {
              authorization: "Bearer " + options.machineToken,
              accept: "application/json",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        catch: (cause) =>
          new TwitchTransportError({
            reason: "Could not reach the Ballast cloud: " + errorMessage(cause),
          }),
      });
      const json = yield* readJson(response);
      if (!response.ok) return yield* apiError(response.status, json);
      return json;
    });

  const decode = <A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown): A =>
    Schema.decodeUnknownSync(schema)(value);

  return {
    baseUrl,
    machineToken: options.machineToken,
    listConnections: call("GET", "/api/connections", undefined).pipe(
      Effect.map((value) => decode(ListConnectionsResponse, value).connections),
    ),
    getToken: (connectionId) =>
      call("POST", "/api/tokens/twitch", { connectionId }).pipe(
        Effect.map((value) => decode(TwitchTokenResponse, value)),
      ),
    reconcile: (connectionId, specs) =>
      call("POST", "/api/twitch/subscriptions/reconcile", {
        connectionId,
        subscriptions: specs,
      }).pipe(
        Effect.map((value) => {
          decode(ReconcileSubscriptionsResponse, value);
        }),
      ),
    helix: (request) =>
      call("POST", "/api/twitch/helix", request).pipe(
        Effect.map((value) => decode(HelixResponse, value)),
      ),
  };
};

const backoffMs = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);

const relayUrl = (baseUrl: string, machineId: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/" + encodeURIComponent(machineId);
  return url.toString();
};

export interface CloudRelay {
  readonly ready: Effect.Effect<void>;
  /**
   * Register a listener for relay messages. The relay buffers events until at
   * least one listener exists, so a hello/replay on connect cannot be acked
   * before a transport has seen it.
   */
  readonly listen: (
    listener: (message: RelayMessage) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export interface CloudRelayOptions {
  readonly baseUrl: string;
  readonly machineId: string;
  readonly machineToken: string;
}

/**
 * One WebSocket per machine (not per Twitch account). Both the cloud gateway
 * and the relay Durable Object replace existing sockets for the same machine,
 * so opening one per connection would make accounts fight.
 */
export const startCloudRelay = (
  options: CloudRelayOptions,
): Effect.Effect<CloudRelay, never, Scope.Scope> =>
  Effect.gen(function* () {
    const relayScope = yield* Scope.Scope;
    const url = relayUrl(options.baseUrl, options.machineId);
    const ready = yield* Deferred.make<void>();
    const lines = yield* Queue.unbounded<string>();
    const current = yield* Ref.make<WebSocket | undefined>(undefined);
    const listeners = new Set<(message: RelayMessage) => Effect.Effect<void>>();
    const pending = yield* Ref.make<ReadonlyArray<RelayMessage>>([]);
    const seen = yield* Ref.make<{
      readonly ids: HashSet.HashSet<string>;
      readonly order: ReadonlyArray<string>;
    }>({ ids: HashSet.empty(), order: [] });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const socket = yield* Ref.get(current);
        socket?.close();
      }),
    );

    const send = (value: { readonly _tag: "ack"; readonly seqs: ReadonlyArray<number> }) =>
      Effect.gen(function* () {
        const socket = yield* Ref.get(current);
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
          socket.send(encodeRelayClientMessage(value));
        }
      });

    const deliver = (message: RelayMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message._tag === "event") {
          // At-least-once relay: a reconnect can replay an event that was
          // published but not acked yet. Drop it and ack the replay.
          const eventId = message.envelope.id;
          const first = yield* Ref.modify(seen, (state) => {
            if (HashSet.has(state.ids, eventId)) return [false, state] as const;
            const order = [...state.order, eventId];
            if (order.length <= 2048) {
              return [true, { ids: HashSet.add(state.ids, eventId), order }] as const;
            }
            const oldest = order[0];
            const rest = order.slice(1);
            return [
              true,
              {
                ids: HashSet.add(
                  oldest === undefined ? state.ids : HashSet.remove(state.ids, oldest),
                  eventId,
                ),
                order: rest,
              },
            ] as const;
          });
          if (!first) {
            yield* send({ _tag: "ack", seqs: [message.seq] });
            return;
          }
        }
        if (listeners.size === 0) {
          yield* Ref.update(pending, (items) => [...items, message]);
          return;
        }
        for (const listener of [...listeners]) yield* listener(message);
        if (message._tag === "event") yield* send({ _tag: "ack", seqs: [message.seq] });
      });

    const handle = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.fromJsonString(RelayServerMessage))(line),
          catch: (cause) => errorMessage(cause),
        }).pipe(
          Effect.catch((reason) =>
            Effect.logWarning("[twitch:cloud] ignoring invalid relay message", reason).pipe(
              Effect.as(undefined),
            ),
          ),
        );
        if (message === undefined) return;

        if (message._tag === "hello") {
          console.log(
            "[twitch:cloud] relay connected (machine " +
              message.machineId +
              ", pending " +
              message.pending +
              ")",
          );
          yield* Deferred.done(ready, Exit.void);
          return;
        }
        if (message._tag === "ping") {
          const socket = yield* Ref.get(current);
          if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
            socket.send(encodeRelayClientMessage({ _tag: "pong", at: message.at }));
          }
          return;
        }
        if (message._tag === "subscription_revoked") {
          console.log(
            "[twitch:cloud] subscription revoked (" +
              message.subscriptionType +
              " for " +
              message.connectionId +
              ")",
          );
        } else {
          console.log("[twitch:cloud] event " + message.envelope.topic);
        }
        yield* deliver(message);
      });

    yield* Stream.fromQueue(lines).pipe(
      Stream.runForEach(handle),
      Effect.forkScoped,
    );

    yield* Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        const socket = new WebSocket(url, {
          headers: { authorization: "Bearer " + options.machineToken },
        });
        yield* Ref.set(current, socket);
        const closed = yield* Deferred.make<void>();

        socket.on("open", () => {
          attempt = 0;
        });
        socket.on("message", (data) => {
          Queue.offerUnsafe(lines, String(data));
        });
        socket.on("error", (cause) => {
          console.log("[twitch:cloud] relay error: " + cause.message);
        });
        socket.on("close", (code, reason) => {
          console.log(
            "[twitch:cloud] relay closed (" +
              code +
              (reason.length === 0 ? "" : " " + reason.toString()) +
              ")",
          );
          Deferred.doneUnsafe(closed, Exit.void);
        });

        yield* Deferred.await(closed);
        yield* Ref.set(current, undefined);
        const delay = backoffMs(attempt);
        attempt += 1;
        console.log("[twitch:cloud] relay reconnecting in " + delay + "ms");
        yield* Effect.sleep(delay);
      }
    }).pipe(Effect.provideService(Scope.Scope, relayScope), Effect.forkScoped);

    const listen = (
      listener: (message: RelayMessage) => Effect.Effect<void>,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        listeners.add(listener);
        const queued = yield* Ref.get(pending);
        yield* Ref.set(pending, []);
        for (const message of queued) {
          yield* listener(message);
          if (message._tag === "event") yield* send({ _tag: "ack", seqs: [message.seq] });
        }
        return yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
        );
      });

    return { ready: Deferred.await(ready), listen };
  });

export interface CloudTwitchTransportOptions {
  readonly slot: string;
  readonly connectionId: string;
  readonly api: CloudApi;
  readonly relay: CloudRelay;
  readonly publish: (topicKey: string, payload: unknown) => void;
}

const identityOf = (token: Schema.Schema.Type<typeof TwitchTokenResponse>): TwitchIdentity => ({
  userId: token.twitchUserId,
  login: token.login,
  scopes: token.scopes,
  accessToken: token.accessToken,
  expiresAt: token.expiresAt,
});

const decodePayload = (topic: string, payload: unknown): unknown => {
  const type = twitchTopicType(topic);
  if (type === undefined || !Twitch.EventSub.isSubscriptionType(type)) return payload;
  const decoded = Schema.decodeUnknownOption(Twitch.EventSub.subscriptions[type].payload)(payload);
  if (Option.isSome(decoded)) return decoded.value;
  console.warn("[twitch:cloud] could not decode " + topic + "; delivering the raw payload");
  return payload;
};

/**
 * The cloud gateway transport: short-lived tokens, relay events and Helix
 * proxying. No Twitch app credentials or refresh tokens reach the machine.
 */
export const startCloudTwitchTransport = (
  options: CloudTwitchTransportOptions,
): Effect.Effect<TwitchTransport, TwitchTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const slot = options.slot;
    const token = yield* Ref.make<
      Schema.Schema.Type<typeof TwitchTokenResponse> | undefined
    >(undefined);
    const desired = yield* Ref.make<ReadonlyArray<TwitchSubscriptionSpec>>([]);

    const getToken = Effect.gen(function* () {
      const cached = yield* Ref.get(token);
      if (cached !== undefined && cached.expiresAt - accessTokenMarginMs > Date.now()) {
        return identityOf(cached);
      }
      const next = yield* options.api.getToken(options.connectionId);
      yield* Ref.set(token, next);
      return identityOf(next);
    });

    const reconcile = (specs: ReadonlyArray<TwitchSubscriptionSpec>) =>
      options.api.reconcile(options.connectionId, specs);

    const subscribe = (
      specs: ReadonlyArray<TwitchSubscriptionSpec>,
    ): Effect.Effect<void, TwitchTransportError> =>
      Effect.gen(function* () {
        yield* Ref.set(desired, specs);
        yield* reconcile(specs).pipe(
          Effect.mapError(
            (error) =>
              new TwitchTransportError({
                reason:
                  "Could not reconcile Twitch EventSub subscriptions for " +
                  slot +
                  ": " +
                  error.message +
                  (error.tag === "missing_scopes" && error.missingScopes !== undefined
                    ? " (missing scopes: " + error.missingScopes.join(", ") + ")"
                    : ""),
                ...(error.tag === undefined ? {} : { tag: error.tag }),
                ...(error.status === undefined ? {} : { status: error.status }),
                ...(error.missingScopes === undefined
                  ? {}
                  : { missingScopes: error.missingScopes }),
              }),
          ),
        );
        for (const spec of specs) {
          console.log("[twitch:" + slot + "] subscribed " + spec.type);
        }
      });

    yield* options.relay.listen((message) =>
      Effect.gen(function* () {
        if (message._tag === "event") {
          const envelope = message.envelope;
          if (
            envelope.integration !== "twitch" ||
            envelope.connectionId !== options.connectionId
          ) {
            return;
          }
          console.log("[twitch:" + slot + "] event " + envelope.topic);
          options.publish(
            busTopic(slot, envelope.topic),
            decodePayload(envelope.topic, envelope.payload),
          );
          return;
        }
        if (
          message._tag === "subscription_revoked" &&
          message.connectionId === options.connectionId
        ) {
          const specs = yield* Ref.get(desired);
          console.log(
            "[twitch:" +
              slot +
              "] subscription revoked; reconciling " +
              specs.length +
              " EventSub subscriptions",
          );
          yield* reconcile(specs).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "[twitch:" + slot + "] reconcile after revocation failed",
                error.message,
              ),
            ),
          );
        }
      }),
    );

    const request = (
      name: Twitch.Helix.RequestName,
      input: unknown,
    ): Effect.Effect<unknown, TwitchTransportError> =>
      Effect.gen(function* () {
        const executor = Twitch.Helix.helixRequests[name];
        const encoded = yield* executor.encode(input).pipe(
          Effect.mapError(
            (error) =>
              new TwitchTransportError({
                reason: error.message,
                ...(error.status === undefined ? {} : { status: error.status }),
              }),
          ),
        );
        const body =
          encoded.body === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(Schema.Json)(encoded.body).pipe(
                Effect.mapError(
                  (cause) =>
                    new TwitchTransportError({
                      reason: "Invalid Helix body for " + name + ": " + cause.message,
                    }),
                ),
              );
        const response = yield* options.api.helix({
          connectionId: options.connectionId,
          method: executor.method,
          path: "/helix" + executor.path,
          query: encoded.query,
          ...(body === undefined ? {} : { body }),
          scopes: executor.scopes,
        });
        if (response.status < 200 || response.status >= 300) {
          const parsed = Option.getOrUndefined(
            Schema.decodeUnknownOption(
              Schema.Struct({ message: Schema.optional(Schema.String) }),
            )(response.body),
          );
          return yield* new TwitchTransportError({
            reason:
              parsed?.message ??
              "Twitch Helix request " + name + " failed (" + response.status + ")",
            status: response.status,
            tag: "upstream_error",
          });
        }
        return yield* executor.decode(response.body).pipe(
          Effect.mapError(
            (error) =>
              new TwitchTransportError({
                reason: error.message,
                ...(error.status === undefined ? {} : { status: error.status }),
              }),
          ),
        );
      });

    return {
      mode: "cloud",
      slot,
      connectionId: options.connectionId,
      getToken,
      subscribe,
      request,
    };
  });
