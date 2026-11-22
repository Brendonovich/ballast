import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { decodeBase64 } from "../base64.ts";
import type {
  WebhookDefinition,
  WebhookDelivery,
  WebhookLocalConfig,
  WebhookStatus,
  WebhookStaticResponse,
  WebhookVerification,
} from "../types.ts";
import { HttpDriverError } from "./errors.ts";
import { WebhookRelay } from "./relay.ts";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_BUFFER_SIZE = 256;

export interface WebhookRuntime {
  readonly deliveries: Stream.Stream<WebhookDelivery>;
  readonly statuses: Effect.Effect<ReadonlyArray<WebhookStatus>>;
  readonly close: Effect.Effect<void>;
}

export class WebhookDriver extends Context.Service<
  WebhookDriver,
  {
    readonly start: (
      definitions: ReadonlyArray<WebhookDefinition>,
    ) => Effect.Effect<WebhookRuntime, HttpDriverError, Scope.Scope>;
  }
>()("ballast/http/WebhookDriver") {}

const responseFor = (
  config: WebhookStaticResponse | undefined,
): HttpServerResponse.HttpServerResponse => {
  const status = config?.status ?? 204;
  const headers = config?.headers;
  if (config?.body === undefined || status === 204 || status === 205) {
    return HttpServerResponse.empty({
      status,
      ...(headers === undefined ? {} : { headers }),
    });
  }
  return HttpServerResponse.text(config.body, {
    status,
    ...(headers === undefined ? {} : { headers }),
    contentType: config.contentType ?? "text/plain; charset=utf-8",
  });
};

const statusResponse = (
  status: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status });

const headerValue = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const verifySignature = (
  verification: WebhookVerification,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const actual = headerValue(headers, verification.header);
  if (actual === undefined) {
    return { ok: false, reason: "missing " + verification.header + " header" };
  }

  if (verification.type === "shared-secret") {
    return constantTimeEqual(actual, verification.secret)
      ? { ok: true }
      : { ok: false, reason: "shared secret did not match" };
  }

  const timestamp = verification.timestampHeader === undefined
    ? undefined
    : headerValue(headers, verification.timestampHeader);
  if (verification.timestampHeader !== undefined && timestamp === undefined) {
    return { ok: false, reason: "missing " + verification.timestampHeader + " header" };
  }
  if (timestamp !== undefined) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric)) {
      return { ok: false, reason: "invalid timestamp header" };
    }
    const seconds = numeric > 100_000_000_000 ? numeric / 1000 : numeric;
    const tolerance = verification.toleranceSeconds ?? 300;
    if (Math.abs(Date.now() / 1000 - seconds) > tolerance) {
      return { ok: false, reason: "timestamp outside tolerance" };
    }
  }

  const signed = timestamp === undefined
    ? Buffer.from(body)
    : Buffer.concat([Buffer.from(timestamp + "."), Buffer.from(body)]);
  const expected = createHmac("sha256", verification.secret)
    .update(signed)
    .digest(verification.encoding);

  const prefix = verification.prefix;
  if (prefix !== undefined && !actual.startsWith(prefix)) {
    return { ok: false, reason: "signature prefix did not match" };
  }
  const provided = prefix === undefined ? actual : actual.slice(prefix.length);
  return constantTimeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "signature did not match" };
};

const verify = (
  verification: WebhookVerification | undefined,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } =>
  verification === undefined ? { ok: true } : verifySignature(verification, headers, body);

const normalizeHeaders = (
  headers: HttpServerRequest.HttpServerRequest["headers"],
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
  }
  return result;
};

class BodyTooLarge extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super("webhook body is " + size + " bytes, over the " + limit + " byte limit");
    this.name = "BodyTooLarge";
    this.size = size;
    this.limit = limit;
  }
}

const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
): Effect.Effect<Uint8Array, string> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    const result = yield* Effect.result(
      request.stream.pipe(
        Stream.runForEach((chunk) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            return Effect.fail(new BodyTooLarge(total, maxBytes));
          }
          chunks.push(chunk);
          return Effect.void;
        }),
      ),
    );
    if (Result.isFailure(result)) {
      const failure = result.failure;
      return yield* Effect.fail(
        failure instanceof BodyTooLarge
          ? failure.message
          : "could not read webhook body: " + failure.message,
      );
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  });

interface LocalRoute {
  readonly path: string;
  readonly definition: WebhookDefinition;
}

interface LocalGroup {
  readonly host: string;
  readonly port: number;
  readonly routes: ReadonlyArray<LocalRoute>;
}

const localPath = (definition: WebhookDefinition): string =>
  definition.local?.path ?? "/hooks/" + definition.slot;

const groupLocal = (
  definitions: ReadonlyArray<WebhookDefinition>,
): Effect.Effect<ReadonlyArray<LocalGroup>, HttpDriverError> =>
  Effect.gen(function* () {
    const groups = new Map<string, { host: string; port: number; routes: LocalRoute[] }>();
    for (const definition of definitions) {
      if (definition.transport !== "local") continue;
      const local: WebhookLocalConfig | undefined = definition.local;
      if (local === undefined) {
        return yield* new HttpDriverError({
          reason:
            "http webhook " + definition.slot + " is local but has no local port configuration",
        });
      }
      const host = local.host ?? "127.0.0.1";
      const key = host + ":" + local.port;
      const group = groups.get(key) ?? { host, port: local.port, routes: [] };
      const path = localPath(definition);
      if (group.routes.some((route) => route.path === path)) {
        return yield* new HttpDriverError({
          reason:
            "http webhooks " + definition.slot + " and another hook both use " + path + " on " + key,
        });
      }
      group.routes.push({ path, definition });
      groups.set(key, group);
    }
    return [...groups.values()];
  });

const localApp = (
  routes: ReadonlyMap<string, WebhookDefinition>,
  queue: Queue.Queue<WebhookDelivery>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const definition = routes.get(url.pathname);
    if (definition === undefined) return statusResponse(404);

    const headers = normalizeHeaders(request.headers);
    const maxBodyBytes = definition.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const body = yield* Effect.result(readBody(request, maxBodyBytes));
    if (Result.isFailure(body)) {
      yield* Effect.logWarning(
        "http/" + definition.slot + " rejected a webhook: " + body.failure,
      );
      return statusResponse(body.failure.includes("over the") ? 413 : 400);
    }

    const verification = verify(definition.verification, headers, body.success);
    if (!verification.ok) {
      yield* Effect.logWarning(
        "http/" + definition.slot + " rejected a webhook: " + verification.reason,
      );
      return statusResponse(401);
    }

    yield* Queue.offer(queue, {
      hook: definition.slot,
      id: randomUUID(),
      source: "local",
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: body.success,
      receivedAt: Date.now(),
    });
    return responseFor(definition.response);
  });

const cloudRegistration = (definition: WebhookDefinition) => {
  const hookId = definition.hookId;
  if (hookId === undefined || hookId.length === 0) {
    return undefined;
  }
  return {
    hookId,
    ...(definition.cloud?.label === undefined ? {} : { label: definition.cloud.label }),
    maxAgeMs: definition.cloud?.maxAgeMs ?? 60_000,
    onStale: definition.cloud?.onStale ?? "drop",
    ...(definition.verification === undefined
      ? {}
      : { verification: definition.verification }),
    ...(definition.response === undefined ? {} : { response: definition.response }),
  };
};

/** Standalone webhook driver: local HTTP listeners plus cloud relay deliveries. */
export const layer: Layer.Layer<WebhookDriver> = Layer.effect(
  WebhookDriver,
  Effect.succeed(
    WebhookDriver.of({
      start: (definitions) =>
        Effect.gen(function* () {
          const statuses = yield* Ref.make<ReadonlyArray<WebhookStatus>>([]);
          const queue = yield* Queue.bounded<WebhookDelivery>(DEFAULT_BUFFER_SIZE);
          const parent = yield* Scope.Scope;
          const scope = yield* Scope.fork(parent, "parallel");
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const setStatus = (status: WebhookStatus): Effect.Effect<void> =>
            Ref.update(statuses, (current) => [
              ...current.filter((candidate) => candidate.slot !== status.slot),
              status,
            ]);

          const groups = yield* groupLocal(definitions);
          for (const group of groups) {
            const routes = new Map(
              group.routes.map((route) => [route.path, route.definition]),
            );
            const server = yield* NodeHttpServer.make(() => createServer(), {
              host: group.host,
              port: group.port,
            }).pipe(
              Effect.mapError(
                (error) => new HttpDriverError({ reason: error.message }),
              ),
              Effect.provideService(Scope.Scope, scope),
            );
            const port = "port" in server.address ? server.address.port : group.port;
            for (const route of group.routes) {
              yield* setStatus({
                slot: route.definition.slot,
                hookId: route.definition.hookId ?? route.definition.slot,
                transport: "local",
                status: "listening",
                address: group.host + ":" + port + route.path,
              });
            }
            yield* server.serve(localApp(routes, queue)).pipe(
              Effect.provideService(Scope.Scope, scope),
            );
            yield* Effect.logInfo(
              "http webhook listener on " + group.host + ":" + port,
            );
          }

          const cloudDefinitions = definitions.filter(
            (definition) => definition.transport === "cloud",
          );
          if (cloudDefinitions.length > 0) {
            const registrations = cloudDefinitions.map(cloudRegistration);
            if (registrations.some((registration) => registration === undefined)) {
              return yield* new HttpDriverError({
                reason:
                  "Every cloud webhook needs a non-empty hookId in connection config",
              });
            }
            const hooks = registrations.filter(
              (registration): registration is NonNullable<typeof registration> =>
                registration !== undefined,
            );
            const relay = yield* Effect.serviceOption(WebhookRelay);
            if (Option.isNone(relay)) {
              return yield* new HttpDriverError({
                reason: "Cloud webhooks need a WebhookRelay service",
              });
            }
            const registered = yield* relay.value.register(hooks);
            const byHookId = new Map(
              cloudDefinitions.map((definition) => [
                definition.hookId ?? definition.slot,
                definition,
              ]),
            );
            for (const definition of cloudDefinitions) {
              const hookId = definition.hookId ?? definition.slot;
              const registeredHook = registered.find((hook) => hook.hookId === hookId);
              yield* setStatus({
                slot: definition.slot,
                hookId,
                transport: "cloud",
                status: "registered",
                ...(registeredHook === undefined ? {} : { url: registeredHook.url }),
              });
            }

            yield* relay.value.deliveries.pipe(
              Stream.runForEach((delivery) =>
                Effect.gen(function* () {
                  const definition = byHookId.get(delivery.hookId);
                  if (definition === undefined) return;
                  const body = decodeBase64(delivery.bodyBase64);
                  const verified = verify(definition.verification, delivery.headers, body);
                  if (!verified.ok) {
                    yield* Effect.logWarning(
                      "http/" + definition.slot + " dropped a relayed webhook: " + verified.reason,
                    );
                    return;
                  }
                  yield* Queue.offer(queue, {
                    hook: definition.slot,
                    id: delivery.deliveryId,
                    source: "cloud",
                    method: delivery.method,
                    path: delivery.path,
                    query: delivery.query,
                    headers: delivery.headers,
                    body,
                    receivedAt: delivery.receivedAt,
                  });
                }),
              ),
              Effect.catch((error: HttpDriverError) =>
                Effect.logWarning("http webhook relay stream failed: " + error.reason),
              ),
              Effect.forkIn(scope),
            );

            yield* Scope.addFinalizer(
              scope,
              relay.value
                .unregister(cloudDefinitions.map((d) => d.hookId ?? d.slot))
                .pipe(Effect.ignore),
            );
          }

          return {
            deliveries: Stream.fromQueue(queue),
            statuses: Ref.get(statuses),
            close: Scope.close(scope, Exit.void),
          };
        }),
    }),
  ),
);
