import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import { decodeResponse } from "../src/decode.ts";
import { HttpClientDriver, layerNode } from "../src/driver/index.ts";

interface MockServer {
  readonly port: number;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: string;
  }>;
}

// A separate helper that owns the Node server lets acquireRelease close it.
const withServer = <A, E, R>(
  respond: (request: MockServer["requests"][number]) => {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: string;
  },
  use: (server: MockServer) => Effect.Effect<A, E, R>,
): Effect.Effect<A, Error | E, Exclude<R, import("effect/Scope").Scope>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new Promise<MockServer & { readonly close: () => void }>((resolve, reject) => {
              const requests: MockServer["requests"] = [];
              const http = createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                  const body = Buffer.concat(chunks).toString("utf8");
                  const captured = {
                    method: request.method ?? "GET",
                    url: request.url ?? "/",
                    headers: request.headers,
                    body,
                  };
                  requests.push(captured);
                  const result = respond(captured);
                  response.writeHead(
                    result.status,
                    result.headers ?? { "content-type": "application/json" },
                  );
                  response.end(result.body);
                });
              });
              http.on("error", reject);
              http.listen(0, "127.0.0.1", () => {
                const address = http.address();
                if (address === null || typeof address === "string") {
                  reject(new Error("no port"));
                  return;
                }
                resolve({
                  port: address.port,
                  requests,
                  close: () => http.close(),
                });
              });
            }),
          catch: (cause) => new Error(String(cause)),
        }),
        (server) => Effect.sync(() => server.close()),
      );
      return yield* use(server);
    }),
  );

describe("HTTP client driver", () => {
  it.live("uses the base URL, config headers, bearer auth and JSON bodies", () =>
    withServer(
      (request) => ({
        status: 200,
        body: JSON.stringify({
          method: request.method,
          url: request.url,
          authorization: request.headers["authorization"],
          defaultHeader: request.headers["x-default"],
          requestHeader: request.headers["x-request"],
          body: request.body,
        }),
      }),
      (server) =>
        Effect.gen(function* () {
          const driver = yield* HttpClientDriver;
          const response = yield* driver.request({
            config: {
              slot: "api",
              baseUrl: "http://127.0.0.1:" + server.port + "/v1/",
              headers: { "x-default": "yes" },
              auth: { type: "bearer", token: "secret-token" },
              allowedHosts: ["127.0.0.1"],
            },
            request: {
              method: "POST",
              path: "echo",
              headers: { "x-request": "ok" },
              body: { type: "json", value: { hello: "world" } },
            },
          });

          expect(response.status).toBe(200);
          expect(JSON.parse(response.text)).toEqual({
            method: "POST",
            url: "/v1/echo",
            authorization: "Bearer secret-token",
            defaultHeader: "yes",
            requestHeader: "ok",
            body: JSON.stringify({ hello: "world" }),
          });
        }).pipe(Effect.provide(layerNode)),
    ),
  );

  it.live("rejects request headers that would bypass connection config", () =>
    withServer(
      () => ({ status: 200, body: "{}" }),
      (server) =>
        Effect.gen(function* () {
          const driver = yield* HttpClientDriver;
          const error = yield* driver
            .request({
              config: {
                slot: "api",
                baseUrl: "http://127.0.0.1:" + server.port,
                allowedHosts: ["127.0.0.1"],
              },
              request: {
                method: "GET",
                path: "/",
                headers: { authorization: "Bearer script-token" },
              },
            })
            .pipe(Effect.flip);
          expect(error.reason).toContain("controlled by connection config");
        }).pipe(Effect.provide(layerNode)),
    ),
  );

  it.live("rejects hosts outside the config and manifest allowlists", () =>
    Effect.gen(function* () {
      const driver = yield* HttpClientDriver;
      const error = yield* driver
        .request({
          config: { slot: "api", baseUrl: "http://127.0.0.1:1" },
          allowedHosts: ["api.example.com"],
          request: { method: "GET", path: "https://evil.example.com/x" },
        })
        .pipe(Effect.flip);
      expect(error.reason).toContain("not allowed to call evil.example.com");
    }).pipe(Effect.provide(layerNode)),
  );

  it.live("returns a typed error for a non-2xx response", () =>
    withServer(
      () => ({ status: 503, body: "nope" }),
      (server) =>
        Effect.gen(function* () {
          const driver = yield* HttpClientDriver;
          const response = yield* driver.request({
            config: {
              slot: "api",
              baseUrl: "http://127.0.0.1:" + server.port,
              allowedHosts: ["127.0.0.1"],
            },
            request: { method: "GET", path: "/" },
          });
          expect(response.status).toBe(503);
          expect(response.text).toBe("nope");
        }).pipe(Effect.provide(layerNode)),
    ),
  );

  it.effect("decodes a JSON response with a user schema", () =>
    Effect.gen(function* () {
      const User = Schema.Struct({ id: Schema.Number, name: Schema.String });
      const response = yield* decodeResponse(
        {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ id: 1, name: "Ada" }),
          url: "http://127.0.0.1/users/1",
        },
        User,
      );
      expect(response.body).toEqual({ id: 1, name: "Ada" });
      expect(response.ok).toBe(true);
    }),
  );
});
