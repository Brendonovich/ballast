import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { encodeBase64 } from "./base64.ts";
import { INTEGRATION } from "./constants.ts";
import { decodeResponse } from "./decode.ts";
import type { HttpResponse } from "./decode.ts";
import type { Integration } from "./constants.ts";
import type {
  HttpDriverBody,
  HttpDriverRequest,
  HttpDriverResponse,
  HttpMethod,
  WebhookDelivery,
} from "./types.ts";

export { INTEGRATION } from "./constants.ts";
export { decodeBase64, encodeBase64 } from "./base64.ts";
export type * from "./types.ts";

export type { HttpResponse } from "./decode.ts";

export interface HttpRequestOptions<A = string> {
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly schema?: Schema.Codec<A, unknown, never, never>;
}

export type HttpRequestBody =
  | { readonly json: unknown }
  | { readonly text: string }
  | { readonly binary: Uint8Array; readonly contentType?: string };

export interface HttpScriptRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: HttpRequestBody;
}

const toDriverBody = (body: HttpRequestBody | undefined): HttpDriverBody | undefined => {
  if (body === undefined) return undefined;
  if ("json" in body) return { type: "json", value: body.json };
  if ("text" in body) return { type: "text", text: body.text };
  return { type: "binary", base64: encodeBase64(body.binary) };
};

const bodyHeaders = (body: HttpRequestBody | undefined): Readonly<Record<string, string>> | undefined => {
  if (body === undefined || !("binary" in body) || body.contentType === undefined) return undefined;
  return { "content-type": body.contentType };
};

export interface HttpClientOptions {
  readonly hosts?: ReadonlyArray<string>;
}

const hostScope = (host: string): string => "http:host:" + host.trim().toLowerCase();

const DriverBodySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("binary"), base64: Schema.String }),
]);

const DriverRequestSchema = Schema.Struct({
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: Schema.String,
  query: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  ),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(DriverBodySchema),
});

const DriverResponseSchema = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  text: Schema.String,
  url: Schema.String,
});

export interface HttpClient extends Ballast.ConnectionRef<Integration> {
  readonly request: <A = string>(
    input: HttpScriptRequest,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
  readonly get: <A = string>(
    path: string,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
  readonly delete: <A = string>(
    path: string,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
  readonly post: <A = string>(
    path: string,
    body: HttpRequestBody,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
  readonly put: <A = string>(
    path: string,
    body: HttpRequestBody,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
  readonly patch: <A = string>(
    path: string,
    body: HttpRequestBody,
    options?: HttpRequestOptions<A>,
  ) => Effect.Effect<HttpResponse<A>>;
}

/**
 * Declare an outgoing HTTP client slot. Base URL, default headers and auth come
 * from the agent's connection config; the script names the hosts it will call.
 * Hosts are recorded as manifest scopes such as http:host:api.example.com.
 */
export const Client = (
  slot: string,
  options: HttpClientOptions = {},
): Effect.Effect<HttpClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "local",
    });
    const hosts =
      options.hosts === undefined || options.hosts.length === 0 ? ["*"] : [...options.hosts];
    const request = yield* Ballast.Request<HttpDriverRequest, HttpDriverResponse>({
      integration: INTEGRATION,
      slot,
      request: "http/request",
      scopes: hosts.map(hostScope),
      inputSchema: DriverRequestSchema,
      outputSchema: DriverResponseSchema,
    });

    const execute = <A>(
      input: HttpScriptRequest,
      options?: HttpRequestOptions<A>,
    ): Effect.Effect<HttpResponse<A>> =>
      Effect.gen(function* () {
        const headers = {
          ...(input.headers ?? {}),
          ...(bodyHeaders(input.body) ?? {}),
        };
        const body = toDriverBody(input.body);
        const driverInput: HttpDriverRequest = {
          method: input.method,
          path: input.path,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(body === undefined ? {} : { body }),
        };
        const response = yield* request(driverInput);
        return yield* decodeResponse(response, options?.schema);
      });

    const withBody = <A>(
      method: HttpMethod,
      path: string,
      body: HttpRequestBody,
      options?: HttpRequestOptions<A>,
    ) => execute<A>({ method, path, body }, options);

    return {
      ...connection,
      request: execute,
      get: (path, options) => execute({ method: "GET", path }, options),
      delete: (path, options) => execute({ method: "DELETE", path }, options),
      post: (path, body, options) => withBody("POST", path, body, options),
      put: (path, body, options) => withBody("PUT", path, body, options),
      patch: (path, body, options) => withBody("PATCH", path, body, options),
    };
  });

export interface WebhookRef extends Ballast.ConnectionRef<Integration> {
  readonly hook: string;
}

export interface WebhookSubscribeOptions {
  readonly onStale?: "drop" | "deliver";
  readonly maxAgeMs?: number;
}

export interface WebhookJsonTopic<A> {
  readonly subscribe: (
    hook: WebhookRef,
    handler: (delivery: A) => Effect.Effect<void>,
    options?: WebhookSubscribeOptions,
  ) => Effect.Effect<void, never, Ballast.EventHost>;
}

const webhookTopic = (
  hook: string,
  options: WebhookSubscribeOptions | undefined,
): Ballast.Topic<WebhookDelivery, Integration> =>
  Ballast.Topic<WebhookDelivery, Integration>({
    integration: INTEGRATION,
    topic: "http/webhook",
    scopes: ["http:webhook:" + hook],
    onStale: options?.onStale ?? "drop",
    maxAgeMs: options?.maxAgeMs ?? 60_000,
    condition: () => ({ hook }),
  });

const subscribeWebhook = (
  hook: WebhookRef,
  handler: (delivery: WebhookDelivery) => Effect.Effect<void>,
  options?: WebhookSubscribeOptions,
): Effect.Effect<void, never, Ballast.EventHost> =>
  webhookTopic(hook.slot, options).subscribe(hook, handler);

const webhookJson = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
): WebhookJsonTopic<A> => ({
  subscribe: (hook, handler, options) => {
    const base = webhookTopic(hook.slot, options);
    return base.subscribe(hook, (delivery) =>
      Effect.gen(function* () {
        const text = new TextDecoder().decode(delivery.body);
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (parsed === undefined) {
          yield* Effect.logWarning("http/" + hook.slot + " webhook body was not JSON");
          return;
        }
        const decoded = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (decoded === undefined) {
          yield* Effect.logWarning("http/" + hook.slot + " webhook body did not match the schema");
          return;
        }
        yield* handler(decoded);
      }),
    );
  },
});

export interface WebhookFunction {
  (slot: string): Effect.Effect<WebhookRef>;
  readonly subscribe: (
    hook: WebhookRef,
    handler: (delivery: WebhookDelivery) => Effect.Effect<void>,
    options?: WebhookSubscribeOptions,
  ) => Effect.Effect<void, never, Ballast.EventHost>;
  readonly json: <A>(
    schema: Schema.Codec<A, unknown, never, never>,
  ) => WebhookJsonTopic<A>;
}

/**
 * Http.Webhook("kofi") declares a slot; Http.Webhook.subscribe(hook, handler)
 * records the topic. The driver answers providers with the static response from
 * connection config; a handler cannot return a response (decision 0005).
 */
export const Webhook: WebhookFunction = Object.assign(
  (slot: string): Effect.Effect<WebhookRef> =>
    Effect.gen(function* () {
      const connection = yield* Ballast.Connection<Integration>({
        integration: INTEGRATION,
        slot,
        location: "either",
      });
      return { ...connection, hook: slot };
    }),
  {
    subscribe: subscribeWebhook,
    json: webhookJson,
  },
);
