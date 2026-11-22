import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { NodeSocket } from "@effect/platform-node";
import type { WebhookStaticResponse, WebhookVerification } from "../types.ts";
import { HttpDriverError } from "./errors.ts";

export interface WebhookRegistration {
  readonly hookId: string;
  readonly label?: string;
  readonly maxAgeMs?: number;
  readonly onStale?: "drop" | "deliver";
  readonly verification?: WebhookVerification;
  readonly response?: WebhookStaticResponse;
}

export interface RegisteredWebhook {
  readonly hookId: string;
  readonly url: string;
}

export interface WebhookRelayDelivery {
  readonly hookId: string;
  readonly deliveryId: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
  readonly receivedAt: number;
}

export interface WebhookRelayFrame {
  readonly _tag: "webhook_delivery";
  readonly seq: number;
  readonly stale: boolean;
  readonly delivery: WebhookRelayDelivery;
}

const RelayDeliverySchema = Schema.Struct({
  hookId: Schema.String,
  deliveryId: Schema.String,
  method: Schema.String,
  path: Schema.String,
  query: Schema.Record(Schema.String, Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  bodyBase64: Schema.String,
  receivedAt: Schema.Number,
});

const WebhookDeliveryFrameSchema = Schema.Struct({
  _tag: Schema.Literal("webhook_delivery"),
  seq: Schema.Number,
  stale: Schema.optionalKey(Schema.Boolean),
  delivery: RelayDeliverySchema,
});

const TagSchema = Schema.Struct({ _tag: Schema.String });

const RegisterResponseSchema = Schema.Struct({
  hooks: Schema.Array(
    Schema.Struct({
      hookId: Schema.String,
      url: Schema.String,
    }),
  ),
});

const decodeRegister = (input: unknown): ReadonlyArray<RegisteredWebhook> =>
  Schema.decodeUnknownSync(RegisterResponseSchema)(input).hooks;

const decodeOption = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  input: unknown,
): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(input));

/** Parse one relay frame. Unknown frame tags are ignored so the shared relay can grow. */
export const decodeWebhookRelayFrame = (input: unknown): WebhookRelayFrame | undefined => {
  const tagged = decodeOption(TagSchema, input);
  if (tagged === undefined || tagged._tag !== "webhook_delivery") return undefined;
  const frame = decodeOption(WebhookDeliveryFrameSchema, input);
  return frame === undefined
    ? undefined
    : {
        _tag: "webhook_delivery",
        seq: frame.seq,
        stale: frame.stale ?? false,
        delivery: frame.delivery,
      };
};

export class WebhookRelay extends Context.Service<
  WebhookRelay,
  {
    readonly register: (
      hooks: ReadonlyArray<WebhookRegistration>,
    ) => Effect.Effect<ReadonlyArray<RegisteredWebhook>, HttpDriverError>;
    readonly unregister: (
      hookIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, HttpDriverError>;
    readonly deliveries: Stream.Stream<WebhookRelayDelivery, HttpDriverError>;
  }
>()("ballast/http/WebhookRelay") {}

export interface WebhookRelayOptions {
  readonly baseUrl: string;
  readonly machineId: string;
  readonly machineToken: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const relayUrl = (baseUrl: string, machineId: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/" + encodeURIComponent(machineId);
  return url.toString();
};

const backoffMs = (attempt: number): number =>
  Math.min(500 * 2 ** Math.min(attempt, 6), 30_000);

const postJson = (
  client: HttpClient.HttpClient,
  url: string,
  token: string,
  body: unknown,
): Effect.Effect<unknown, HttpDriverError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          authorization: "Bearer " + token,
          accept: "application/json",
          "content-type": "application/json",
        }),
        HttpClientRequest.bodyText(JSON.stringify(body), "application/json; charset=utf-8"),
      );
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          (error) =>
            new HttpDriverError({
              reason: "Could not reach the Ballast cloud: " + errorMessage(error),
              url,
            }),
        ),
      );
      const text = yield* response.text.pipe(
        Effect.mapError(
          (error) =>
            new HttpDriverError({
              reason: "Could not read the Ballast cloud response: " + errorMessage(error),
              status: response.status,
              url,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new HttpDriverError({
          reason:
            "Ballast cloud hook registration failed (" + response.status + "): " + text.slice(0, 500),
          status: response.status,
          url,
        });
      }
      if (text.trim().length === 0) return undefined;
      return yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          new HttpDriverError({
            reason: "Ballast cloud returned invalid JSON: " + errorMessage(cause),
            status: response.status,
            url,
          }),
      });
    }),
  );

/**
 * Agent-side relay client for the proposed cloud webhook protocol in decision
 * 0005: registration over the machine API, deliveries over the existing relay
 * WebSocket as `webhook_delivery` frames, acknowledged with the shared
 * `ack` frame. Deliveries are acked as soon as they enter the local queue.
 */
export const layer = (
  options: WebhookRelayOptions,
): Layer.Layer<
  WebhookRelay,
  never,
  HttpClient.HttpClient | Socket.WebSocketConstructor
> =>
  Layer.effect(
    WebhookRelay,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const constructor = yield* Socket.WebSocketConstructor;
      const baseUrl = options.baseUrl.replace(/\/$/, "");
      const deliveries = yield* Queue.unbounded<WebhookRelayDelivery>();

      const makeSocket = (url: string) =>
        Socket.makeWebSocket(url, {
          headers: { authorization: "Bearer " + options.machineToken },
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));

      const socketLoop = Effect.gen(function* () {
        let attempt = 0;
        while (true) {
          const exit = yield* Effect.exit(
            Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* makeSocket(relayUrl(baseUrl, options.machineId));
                const reader = yield* socket.reader;
                const writer = yield* socket.writer;
                attempt = 0;
                while (true) {
                  const batch = yield* reader.pull;
                  for (const frame of batch) {
                    if (typeof frame !== "string") continue;
                    const parsed = yield* Effect.try({
                      try: () => JSON.parse(frame) as unknown,
                      catch: () => undefined,
                    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
                    if (parsed === undefined) continue;

                    const tagged = decodeOption(TagSchema, parsed);
                    if (tagged === undefined) continue;
                    if (tagged._tag === "ping") {
                      yield* writer.write(
                        JSON.stringify({
                          _tag: "pong",
                          at: Predicate.hasProperty(parsed, "at") && typeof parsed.at === "number"
                            ? parsed.at
                            : Date.now(),
                        }),
                      );
                      continue;
                    }
                    if (tagged._tag !== "webhook_delivery") continue;

                    const decoded = decodeWebhookRelayFrame(parsed);
                    if (decoded === undefined) {
                      yield* Effect.logWarning("http/relay ignored a malformed webhook_delivery frame");
                      continue;
                    }
                    yield* Queue.offer(deliveries, decoded.delivery);
                    yield* writer.write(
                      JSON.stringify({ _tag: "ack", seqs: [decoded.seq] }),
                    );
                  }
                }
              }),
            ),
          );
          const reason = Exit.isFailure(exit)
            ? errorMessage(Cause.squash(exit.cause))
            : "connection closed";
          yield* Effect.logWarning("http/relay disconnected: " + reason);
          yield* Effect.sleep(backoffMs(attempt));
          attempt += 1;
        }
      });

      yield* Effect.forkScoped(socketLoop);

      return WebhookRelay.of({
        register: (hooks) =>
          Effect.gen(function* () {
            // A full-set replace must reach the cloud even when the set is
            // empty, otherwise stopping the last webhook leaves its cloud
            // registration alive forever.
            const body = {
              hooks: hooks.map((hook) => ({
                hookId: hook.hookId,
                ...(hook.label === undefined ? {} : { label: hook.label }),
                ...(hook.maxAgeMs === undefined ? {} : { maxAgeMs: hook.maxAgeMs }),
                ...(hook.onStale === undefined ? {} : { onStale: hook.onStale }),
                ...(hook.verification === undefined
                  ? {}
                  : { verification: hook.verification }),
                ...(hook.response === undefined
                  ? {}
                  : {
                      response: {
                        ...(hook.response.status === undefined
                          ? {}
                          : { status: hook.response.status }),
                        ...(hook.response.body === undefined
                          ? {}
                          : { body: hook.response.body }),
                        ...(hook.response.headers === undefined
                          ? {}
                          : { headers: hook.response.headers }),
                        ...(hook.response.contentType === undefined
                          ? {}
                          : { contentType: hook.response.contentType }),
                      },
                    }),
              })),
            };
            const response = yield* postJson(
              client,
              baseUrl + "/api/hooks/register",
              options.machineToken,
              body,
            );
            return yield* Effect.try({
              try: () => decodeRegister(response),
              catch: (cause) =>
                new HttpDriverError({
                  reason: "Invalid hook registration response: " + errorMessage(cause),
                }),
            });
          }),
        unregister: (hookIds) =>
          Effect.gen(function* () {
            if (hookIds.length === 0) return;
            yield* postJson(client, baseUrl + "/api/hooks/unregister", options.machineToken, {
              hookIds,
            });
          }),
        deliveries: Stream.fromQueue(deliveries),
      });
    }),
  );

/** Relay client wired to Node fetch and ws. */
export const layerNode = (options: WebhookRelayOptions) =>
  layer(options).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeSocket.layerWebSocketConstructorWS),
  );
