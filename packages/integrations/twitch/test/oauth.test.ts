import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { make } from "../src/oauth/client.ts";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const startServer = (
  respond: (request: RecordedRequest, response: ServerResponse) => void,
): Effect.Effect<
  { readonly url: string; readonly requests: Array<RecordedRequest> },
  Error,
  import("effect/Scope").Scope
> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ url: string; requests: Array<RecordedRequest>; server: Server }>(
          (resolve, reject) => {
            const requests: Array<RecordedRequest> = [];
            const server = createServer((incoming, response) => {
              void readBody(incoming).then((body) => {
                const recorded: RecordedRequest = {
                  method: incoming.method ?? "GET",
                  url: incoming.url ?? "/",
                  headers: incoming.headers,
                  body,
                };
                requests.push(recorded);
                respond(recorded, response);
              });
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (address === null || typeof address === "string") {
                reject(new Error("No port"));
                return;
              }
              resolve({ url: "http://127.0.0.1:" + address.port, requests, server });
            });
          },
        ),
      catch: (cause) => new Error(String(cause)),
    }),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(Effect.map(({ url, requests }) => ({ url, requests })));

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const tokenBody = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
  scope: ["user:read:chat"],
  token_type: "bearer",
};

describe("Twitch OAuth", () => {
  it.effect("builds the authorization URL with scopes and state", () =>
    Effect.gen(function* () {
      const client = yield* make({ clientId: "client-id" });
      const url = new URL(
        client.authorizeUrl({
          redirectUri: "http://127.0.0.1:3000/callback",
          scopes: ["channel:read:redemptions", "bits:read"],
          state: "state-1",
        }),
      );
      expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
      expect(url.searchParams.get("client_id")).toBe("client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/callback");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe("channel:read:redemptions bits:read");
      expect(url.searchParams.get("state")).toBe("state-1");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("exchanges and refreshes authorization codes", () =>
    Effect.gen(function* () {
      const server = yield* startServer((request, response) => {
        if (request.url === "/token") {
          json(response, 200, tokenBody);
          return;
        }
        json(response, 404, {});
      });

      const client = yield* make({
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenUrl: server.url + "/token",
      });

      const token = yield* client.exchangeCode({
        code: "auth-code",
        redirectUri: "http://127.0.0.1:3000/callback",
      });
      expect(token.accessToken).toBe("access-1");
      expect(token.refreshToken).toBe("refresh-1");
      expect(token.scopes).toEqual(["user:read:chat"]);

      const exchanged = new URLSearchParams(server.requests[0]?.body);
      expect(exchanged.get("grant_type")).toBe("authorization_code");
      expect(exchanged.get("code")).toBe("auth-code");
      expect(exchanged.get("client_id")).toBe("client-id");
      expect(exchanged.get("client_secret")).toBe("client-secret");
      expect(exchanged.get("redirect_uri")).toBe("http://127.0.0.1:3000/callback");

      const refreshed = yield* client.refreshToken("refresh-1");
      expect(refreshed.accessToken).toBe("access-1");
      const refreshedBody = new URLSearchParams(server.requests[1]?.body);
      expect(refreshedBody.get("grant_type")).toBe("refresh_token");
      expect(refreshedBody.get("refresh_token")).toBe("refresh-1");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("exchanges client credentials for an app access token", () =>
    Effect.gen(function* () {
      const server = yield* startServer((request, response) => {
        if (request.url === "/token") {
          json(response, 200, {
            access_token: "app-access-1",
            expires_in: 5_184_000,
            token_type: "bearer",
          });
          return;
        }
        json(response, 404, {});
      });

      const client = yield* make({
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenUrl: server.url + "/token",
      });
      const token = yield* client.clientCredentials;
      expect(token.accessToken).toBe("app-access-1");
      expect(token.refreshToken).toBeUndefined();
      expect(token.scopes).toEqual([]);
      const body = new URLSearchParams(server.requests[0]?.body);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("client-id");
      expect(body.get("client_secret")).toBe("client-secret");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("validates an access token", () =>
    Effect.gen(function* () {
      const server = yield* startServer((request, response) => {
        if (request.url === "/validate") {
          json(response, 200, {
            client_id: "client-id",
            login: "cool_user",
            scopes: ["channel:read:redemptions"],
            user_id: "1337",
            expires_in: 5000,
          });
          return;
        }
        json(response, 404, {});
      });

      const client = yield* make({ clientId: "client-id", validateUrl: server.url + "/validate" });
      const validation = yield* client.validateToken("access-1");
      expect(validation.login).toBe("cool_user");
      expect(validation.userId).toBe("1337");
      expect(server.requests[0]?.headers["authorization"]).toBe("OAuth access-1");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.live("runs the device-code flow through pending to authorized", () =>
    Effect.gen(function* () {
      let polls = 0;
      const server = yield* startServer((request, response) => {
        if (request.url === "/device") {
          json(response, 200, {
            device_code: "device-1",
            user_code: "ABCD1234",
            verification_uri: "https://www.twitch.tv/activate",
            expires_in: 1800,
            interval: 5,
          });
          return;
        }
        if (request.url === "/token") {
          polls += 1;
          if (polls === 1) {
            json(response, 400, { status: 400, message: "authorization_pending" });
          } else {
            json(response, 200, tokenBody);
          }
          return;
        }
        json(response, 404, {});
      });

      const client = yield* make({
        clientId: "client-id",
        tokenUrl: server.url + "/token",
        deviceUrl: server.url + "/device",
      });

      const authorization = yield* client.startDeviceAuthorization(["user:read:chat"]);
      expect(authorization.userCode).toBe("ABCD1234");
      expect(authorization.intervalSeconds).toBe(5);

      const pending = yield* client.pollDeviceToken({ deviceCode: "device-1" });
      expect(pending._tag).toBe("pending");

      const token = yield* client.waitForDeviceToken({
        deviceCode: "device-1",
        scopes: ["user:read:chat"],
        intervalSeconds: 0,
        expiresIn: 30,
      });
      expect(token.accessToken).toBe("access-1");
      expect(polls).toBe(2);
      expect(new URLSearchParams(server.requests[2]?.body).get("scopes")).toBe(
        "user:read:chat",
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("maps an OAuth error response", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        json(response, 400, {
          status: 400,
          message: "Invalid authorization code",
          error: "invalid_grant",
        });
      });

      const client = yield* make({ clientId: "client-id", tokenUrl: server.url + "/token" });
      const error = yield* Effect.flip(
        client.exchangeCode({ code: "bad", redirectUri: "http://127.0.0.1/callback" }),
      );
      expect(error._tag).toBe("TwitchOAuthError");
      expect(error.code).toBe("invalid_grant");
      expect(error.status).toBe(400);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

});
