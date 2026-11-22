import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { FetchHttpClient } from "effect/http";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { make } from "../src/helix/client.ts";
import { HelixError } from "../src/helix/errors.ts";
import { requests } from "../src/helix/requests.ts";
import { TokenProvider } from "../src/protocol/token.ts";
import type { HelixToken } from "../src/protocol/token.ts";

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
        new Promise<{
          url: string;
          requests: Array<RecordedRequest>;
          server: Server;
        }>((resolve, reject) => {
          const requests: Array<RecordedRequest> = [];
          const server: Server = createServer((incoming, response) => {
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
        }),
      catch: (cause) => new Error(String(cause)),
    }),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(Effect.map(({ url, requests }) => ({ url, requests })));

const userResponse = {
  data: [
    {
      id: "141981764",
      login: "twitchdev",
      display_name: "TwitchDev",
      type: "",
      broadcaster_type: "partner",
      description: "Twitch development",
      profile_image_url: "https://example.com/profile.png",
      offline_image_url: "https://example.com/offline.png",
      view_count: 0,
      email: "twitchdev@example.com",
      created_at: "2016-12-14T20:32:28Z",
    },
  ],
};

const staticToken = (token: HelixToken) =>
  Layer.succeed(TokenProvider, {
    getToken: Effect.succeed(token),
    refresh: undefined,
  });

const fetchLayer = FetchHttpClient.layer;
const testLayer = (token: HelixToken) =>
  Layer.mergeAll(fetchLayer, staticToken(token));

const usersJson = JSON.stringify(userResponse);

describe("Helix executor", () => {
  it.effect("sends Client-Id and Authorization, encodes query params, decodes data", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(usersJson);
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url + "/helix" });
        return yield* client.getUsers({ login: "twitchdev" });
      });

      const result = yield* Effect.provide(
        program,
        testLayer({ accessToken: "token-1", clientId: "client-id-1" }),
      );
      expect(result.data[0]?.login).toBe("twitchdev");
      expect(result.data[0]?.email).toBe("twitchdev@example.com");
      expect(result.data[0]?.created_at).toBeInstanceOf(Date);
      expect(server.requests[0]?.method).toBe("GET");
      expect(server.requests[0]?.url).toBe("/helix/users?login=twitchdev");
      expect(server.requests[0]?.headers["client-id"]).toBe("client-id-1");
      expect(server.requests[0]?.headers["authorization"]).toBe("Bearer token-1");
    }),
  );

  it.effect("sends a JSON body and keeps query/body fields separate", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              {
                id: "reward-1",
                title: "Hydrate",
                prompt: "Drink water",
                cost: 250,
                is_enabled: true,
                is_user_input_required: false,
                is_paused: false,
                is_in_stock: true,
                should_redemptions_skip_request_queue: false,
                background_color: "#00E5CB",
              },
            ],
          }),
        );
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url + "/helix" });
        return yield* client.createCustomReward({
          broadcaster_id: "1337",
          title: "Hydrate",
          cost: 250,
          prompt: "Drink water",
        });
      });

      const result = yield* Effect.provide(
        program,
        testLayer({ accessToken: "token-1", clientId: "client-id-1" }),
      );
      expect(result.data[0]?.id).toBe("reward-1");
      expect(server.requests[0]?.method).toBe("POST");
      expect(server.requests[0]?.url).toBe(
        "/helix/channel_points/custom_rewards?broadcaster_id=1337",
      );
      expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({
        title: "Hydrate",
        cost: 250,
        prompt: "Drink water",
      });
    }),
  );

  it.effect("creates an EventSub WebSocket subscription with the session id", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              {
                id: "sub-1",
                status: "enabled",
                type: "channel.chat.message",
                version: "1",
                condition: { broadcaster_user_id: "1337", user_id: "9001" },
                created_at: "2023-11-06T18:11:47.492253549Z",
                transport: { method: "websocket", session_id: "session-1" },
                cost: 0,
              },
            ],
            total: 1,
            total_cost: 0,
            max_total_cost: 10,
          }),
        );
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url + "/helix" });
        return yield* client.createEventSubSubscription({
          type: "channel.chat.message",
          version: "1",
          condition: { broadcaster_user_id: "1337", user_id: "9001" },
          transport: { method: "websocket", session_id: "session-1" },
        });
      });

      const result = yield* Effect.provide(
        program,
        testLayer({ accessToken: "token-1", clientId: "client-id-1" }),
      );
      expect(result.data[0]?.transport).toEqual({
        method: "websocket",
        session_id: "session-1",
      });
      expect(server.requests[0]?.method).toBe("POST");
      expect(server.requests[0]?.url).toBe("/helix/eventsub/subscriptions");
      expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: "1337", user_id: "9001" },
        transport: { method: "websocket", session_id: "session-1" },
      });
    }),
  );

  it.effect("refreshes the token once after a 401 and retries", () =>
    Effect.gen(function* () {
      let calls = 0;
      const server = yield* startServer((_request, response) => {
        calls += 1;
        if (calls === 1) {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }),
          );
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(usersJson);
        }
      });

      const refreshes = yield* Ref.make(0);
      const tokenLayer = Layer.succeed(TokenProvider, {
        getToken: Effect.succeed({ accessToken: "old-token", clientId: "client-id-1" }),
        refresh: Effect.gen(function* () {
          yield* Ref.update(refreshes, (count) => count + 1);
          return { accessToken: "new-token", clientId: "client-id-1" };
        }),
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url + "/helix" });
        return yield* client.getUsers({ login: "twitchdev" });
      });

      const result = yield* Effect.provide(program, Layer.merge(fetchLayer, tokenLayer));
      expect(result.data[0]?.login).toBe("twitchdev");
      expect(server.requests.length).toBe(2);
      expect(server.requests[0]?.headers["authorization"]).toBe("Bearer old-token");
      expect(server.requests[1]?.headers["authorization"]).toBe("Bearer new-token");
      expect(yield* Ref.get(refreshes)).toBe(1);
    }),
  );

  it.effect("maps a 401 without a refresh hook to HelixError", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: "Unauthorized", status: 401, message: "Invalid OAuth token" }),
        );
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url + "/helix" });
        return yield* Effect.flip(client.getUsers({ login: "twitchdev" }));
      });

      const error = yield* Effect.provide(
        program,
        testLayer({ accessToken: "bad-token", clientId: "client-id-1" }),
      );
      expect(error).toBeInstanceOf(HelixError);
      if (!(error instanceof HelixError)) return;
      expect(error.status).toBe(401);
      expect(error.code).toBe("Unauthorized");
      expect(error.reason).toBe("Invalid OAuth token");
      expect(server.requests.length).toBe(1);
    }),
  );

  it.effect("preserves status and body for arbitrary raw Helix calls", () =>
    Effect.gen(function* () {
      const server = yield* startServer((_request, response) => {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Not Found", status: 404, message: "No such path" }));
      });

      const program = Effect.gen(function* () {
        const client = yield* make({ baseUrl: server.url });
        return yield* client.requestRaw({
          method: "POST",
          path: "/helix/rpc",
          query: { id: ["1", "2"] },
          body: { hello: "world" },
        });
      });

      const result = yield* Effect.provide(
        program,
        testLayer({ accessToken: "token-1", clientId: "client-id-1" }),
      );
      expect(result.status).toBe(404);
      expect(result.body).toEqual({
        error: "Not Found",
        status: 404,
        message: "No such path",
      });
      expect(server.requests[0]?.method).toBe("POST");
      expect(server.requests[0]?.url).toBe("/helix/rpc?id=1&id=2");
      expect(server.requests[0]?.headers["client-id"]).toBe("client-id-1");
      expect(server.requests[0]?.headers["authorization"]).toBe("Bearer token-1");
      expect(server.requests[0]?.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({ hello: "world" });
    }),
  );

  it.effect("exposes Helix requests as data with scopes", () =>
    Effect.gen(function* () {
      expect(requests.createCustomReward.scopes).toEqual(["channel:manage:redemptions"]);
      expect(requests.getUsers.scopes).toEqual([]);
      expect(requests.sendChatMessage.path).toBe("/chat/messages");
      expect(requests.createEventSubSubscription.method).toBe("POST");
    }),
  );
});
