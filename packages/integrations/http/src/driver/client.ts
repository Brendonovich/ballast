import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { decodeBase64, encodeBase64 } from "../base64.ts";
import type {
  HttpAuth,
  HttpClientConfig,
  HttpDriverBody,
  HttpDriverRequest,
  HttpDriverResponse,
  HttpMethod,
} from "../types.ts";
import { HttpDriverError } from "./errors.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const forbiddenRequestHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
]);

export interface HttpClientDriverRequest {
  readonly config: HttpClientConfig;
  readonly request: HttpDriverRequest;
  /** Hosts the script declared in its manifest, e.g. http:host scopes. */
  readonly allowedHosts?: ReadonlyArray<string>;
}

export class HttpClientDriver extends Context.Service<
  HttpClientDriver,
  {
    readonly request: (
      input: HttpClientDriverRequest,
    ) => Effect.Effect<HttpDriverResponse, HttpDriverError>;
  }
>()("ballast/http/HttpClientDriver") {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const displayUrl = (url: URL): string => {
  const copy = new URL(url);
  copy.username = "";
  copy.password = "";
  return copy.href;
};

const hostMatches = (host: string, url: URL): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "*" ||
    normalized === url.hostname.toLowerCase() ||
    normalized === url.host.toLowerCase()
  );
};

const hostAllowed = (
  url: URL,
  config: HttpClientConfig,
  scriptHosts: ReadonlyArray<string> | undefined,
): boolean => {
  const scriptList = scriptHosts?.filter((host) => host.trim().length > 0) ?? [];
  const configList = config.allowedHosts?.filter((host) => host.trim().length > 0) ?? [];
  const scriptAny = scriptList.length === 0 || scriptList.includes("*");

  if (!scriptAny && !scriptList.some((host) => hostMatches(host, url))) {
    return false;
  }
  if (configList.length > 0) {
    return configList.some((host) => hostMatches(host, url));
  }
  if (scriptAny) {
    return url.hostname.toLowerCase() === new URL(config.baseUrl).hostname.toLowerCase();
  }
  return true;
};

const parseBaseUrl = (config: HttpClientConfig): Effect.Effect<URL, HttpDriverError> =>
  Effect.try({
    try: () => new URL(config.baseUrl),
    catch: () =>
      new HttpDriverError({
        reason: "Invalid HTTP base URL for slot " + config.slot + ": " + config.baseUrl,
      }),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "http:" || url.protocol === "https:"
        ? Effect.succeed(url)
        : Effect.fail(
            new HttpDriverError({
              reason: "HTTP base URL must use http:// or https://, got " + url.protocol,
            }),
          ),
    ),
  );

const resolveUrl = (
  config: HttpClientConfig,
  input: HttpDriverRequest,
): Effect.Effect<URL, HttpDriverError> =>
  parseBaseUrl(config).pipe(
    Effect.flatMap((base) =>
      Effect.try({
        try: () => new URL(input.path, base),
        catch: () =>
          new HttpDriverError({
            reason: "Invalid HTTP request path: " + input.path,
            url: base.href,
          }),
      }),
    ),
    Effect.flatMap((url) => {
      if (url.username !== "" || url.password !== "") {
        return Effect.fail(
          new HttpDriverError({
            reason: "HTTP request URLs must not contain credentials; put secrets in connection config",
            url: displayUrl(url),
          }),
        );
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return Effect.fail(
          new HttpDriverError({
            reason: "HTTP requests must use http:// or https://, got " + url.protocol,
            url: displayUrl(url),
          }),
        );
      }
      if (input.query !== undefined) {
        for (const [key, value] of Object.entries(input.query)) {
          url.searchParams.set(key, String(value));
        }
      }
      url.hash = "";
      return Effect.succeed(url);
    }),
  );

const authHeader = (auth: HttpAuth): Effect.Effect<Record<string, string>, HttpDriverError> => {
  switch (auth.type) {
    case "bearer": {
      if (auth.token === undefined || auth.token.length === 0) {
        return Effect.fail(new HttpDriverError({ reason: "Bearer auth is missing a token" }));
      }
      return Effect.succeed({ authorization: "Bearer " + auth.token });
    }
    case "basic": {
      if (auth.username === undefined || auth.password === undefined) {
        return Effect.fail(new HttpDriverError({ reason: "Basic auth is missing a username or password" }));
      }
      const encoded = encodeBase64(
        new TextEncoder().encode(auth.username + ":" + auth.password),
      );
      return Effect.succeed({ authorization: "Basic " + encoded });
    }
    case "header": {
      if (auth.name === undefined || auth.value === undefined) {
        return Effect.fail(new HttpDriverError({ reason: "Header auth is missing a name or value" }));
      }
      return Effect.succeed({ [auth.name]: auth.value });
    }
  }
};

const validateHeaders = (
  headers: Readonly<Record<string, string>>,
  source: string,
): Effect.Effect<Record<string, string>, HttpDriverError> =>
  Effect.gen(function* () {
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.length === 0 || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        return yield* new HttpDriverError({
          reason: source + " header names and values must not contain CR or LF",
        });
      }
      const lower = name.toLowerCase();
      if (source === "request" && forbiddenRequestHeaders.has(lower)) {
        return yield* new HttpDriverError({
          reason:
            "Header " + lower + " is controlled by connection config, not scripts",
        });
      }
      if (source === "request" && lower.startsWith("sec-")) {
        return yield* new HttpDriverError({
          reason: "Header " + lower + " is controlled by the transport",
        });
      }
      normalized[lower] = value;
    }
    return normalized;
  });

const buildHeaders = (
  config: HttpClientConfig,
  request: HttpDriverRequest,
): Effect.Effect<Record<string, string>, HttpDriverError> =>
  Effect.gen(function* () {
    const defaults = yield* validateHeaders(config.headers ?? {}, "connection");
    const auth = config.auth === undefined ? {} : yield* authHeader(config.auth);
    const extra = yield* validateHeaders(request.headers ?? {}, "request");
    return { ...defaults, ...auth, ...extra };
  });

const jsonText = (value: unknown): Effect.Effect<string, HttpDriverError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) =>
      new HttpDriverError({
        reason: "Could not encode JSON body: " + errorMessage(cause),
      }),
  }).pipe(
    Effect.flatMap((text) =>
      typeof text === "string"
        ? Effect.succeed(text)
        : Effect.fail(new HttpDriverError({ reason: "JSON body is not serialisable" })),
    ),
  );

interface EncodedBody {
  readonly content: string | Uint8Array;
  readonly contentType: string;
}

const encodeBody = (
  body: HttpDriverBody,
): Effect.Effect<EncodedBody, HttpDriverError> => {
  switch (body.type) {
    case "json":
      return jsonText(body.value).pipe(
        Effect.map((text) => ({ content: text, contentType: "application/json; charset=utf-8" })),
      );
    case "text":
      return Effect.succeed({ content: body.text, contentType: "text/plain; charset=utf-8" });
    case "binary":
      return Effect.try({
        try: () => decodeBase64(body.base64),
        catch: (cause) =>
          new HttpDriverError({ reason: "Invalid base64 binary body: " + errorMessage(cause) }),
      }).pipe(
        Effect.map((bytes) => ({ content: bytes, contentType: "application/octet-stream" })),
      );
  }
};

const responseHeaders = (
  headers: HttpClientResponse.HttpClientResponse["headers"],
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
};

const readResponse = (
  response: HttpClientResponse.HttpClientResponse,
  maxResponseBytes: number,
): Effect.Effect<HttpDriverResponse, HttpDriverError> =>
  Effect.gen(function* () {
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      return yield* new HttpDriverError({
        reason: "HTTP response body exceeds " + maxResponseBytes + " bytes",
        status: response.status,
        url: response.url,
      });
    }
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (error) =>
          new HttpDriverError({
            reason: "Could not read HTTP response: " + errorMessage(error),
            status: response.status,
            url: response.url,
          }),
      ),
    );
    if (buffer.byteLength > maxResponseBytes) {
      return yield* new HttpDriverError({
        reason: "HTTP response body exceeds " + maxResponseBytes + " bytes",
        status: response.status,
        url: response.url,
      });
    }
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      text: new TextDecoder().decode(buffer),
      url: response.url,
    };
  });

const redirectMethod = (
  status: number,
  method: HttpMethod,
): HttpMethod =>
  status === 303 || ((status === 301 || status === 302) && method === "POST") ? "GET" : method;

const safeRedirectHeaders = (
  previous: URL,
  next: URL,
  headers: Record<string, string>,
): Record<string, string> => {
  if (previous.origin === next.origin) return headers;
  const kept: Record<string, string> = {};
  for (const name of ["accept", "content-type"]) {
    const value = headers[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
};

export const layer: Layer.Layer<HttpClientDriver, never, HttpClient.HttpClient> = Layer.effect(
  HttpClientDriver,
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const client = HttpClient.withScope(baseClient);

    return HttpClientDriver.of({
      request: (input) =>
        Effect.gen(function* () {
          const config = input.config;
          const url = yield* resolveUrl(config, input.request);
          const headers = yield* buildHeaders(config, input.request);
          const body = yield* (input.request.body === undefined
            ? Effect.succeed(undefined)
            : encodeBody(input.request.body));
          if (body !== undefined && (input.request.method === "GET" || input.request.method === "HEAD")) {
            return yield* new HttpDriverError({
              reason: input.request.method + " requests cannot have a body",
              url: displayUrl(url),
            });
          }

          const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
          const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

          const run = Effect.scoped(
            Effect.gen(function* () {
              let method = input.request.method;
              let currentUrl = url;
              let currentHeaders = headers;
              let currentBody = body;
              let redirects = 0;
              const visited = new Set<string>([method + " " + currentUrl.href]);

              while (true) {
                if (!hostAllowed(currentUrl, config, input.allowedHosts)) {
                  return yield* new HttpDriverError({
                    reason:
                      "HTTP slot " + config.slot + " is not allowed to call " + currentUrl.hostname,
                    url: displayUrl(currentUrl),
                  });
                }

                let outgoing = HttpClientRequest.make(method)(currentUrl);
                outgoing = HttpClientRequest.setHeaders(outgoing, currentHeaders);
                if (currentBody !== undefined) {
                  outgoing = typeof currentBody.content === "string"
                    ? HttpClientRequest.bodyText(
                        outgoing,
                        currentBody.content,
                        currentBody.contentType,
                      )
                    : HttpClientRequest.bodyUint8Array(
                        outgoing,
                        currentBody.content,
                        currentBody.contentType,
                      );
                }

                const response = yield* client.execute(outgoing).pipe(
                  Effect.mapError(
                    (error) =>
                      new HttpDriverError({
                        reason: "HTTP request failed: " + errorMessage(error),
                        url: displayUrl(currentUrl),
                      }),
                  ),
                );

                const location = response.headers["location"];
                if (
                  !redirectStatuses.has(response.status) ||
                  location === undefined ||
                  method === "HEAD"
                ) {
                  return yield* readResponse(response, maxResponseBytes);
                }

                if (redirects >= MAX_REDIRECTS) {
                  return yield* new HttpDriverError({
                    reason: "HTTP redirect limit of " + MAX_REDIRECTS + " exceeded",
                    status: response.status,
                    url: displayUrl(currentUrl),
                  });
                }

                const next = yield* Effect.try({
                  try: () => new URL(location, currentUrl),
                  catch: () =>
                    new HttpDriverError({
                      reason: "Invalid redirect location: " + location,
                      status: response.status,
                      url: displayUrl(currentUrl),
                    }),
                });
                next.hash = "";
                const nextMethod = redirectMethod(response.status, method);
                const key = nextMethod + " " + next.href;
                if (visited.has(key)) {
                  return yield* new HttpDriverError({
                    reason: "HTTP redirect loop detected",
                    status: response.status,
                    url: displayUrl(next),
                  });
                }
                visited.add(key);
                currentHeaders = safeRedirectHeaders(currentUrl, next, currentHeaders);
                if (nextMethod === "GET") {
                  delete currentHeaders["content-type"];
                  currentBody = undefined;
                }
                currentUrl = next;
                method = nextMethod;
                redirects += 1;
              }
            }),
          );

          return yield* run.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () =>
                Effect.fail(
                  new HttpDriverError({
                    reason: "HTTP request timed out after " + timeoutMs + "ms",
                    url: displayUrl(url),
                  }),
                ),
            }),
          );
        }),
    });
  }),
);
