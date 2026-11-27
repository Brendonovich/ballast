import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { writeStoredTwitchAccount } from "../../src/twitch/config.ts";

export interface MockTwitchServerOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly userId?: string;
  readonly login?: string;
  readonly scopes?: ReadonlyArray<string>;
}

export interface MockSubscription {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly condition: Readonly<Record<string, string>>;
  readonly sessionId: string;
  status: "enabled";
  readonly createdAt: string;
}

export interface MockRedemption {
  readonly title: string;
  readonly userId?: string;
  readonly rewardId?: string;
}

export interface MockTwitchServer {
  readonly idBaseUrl: string;
  readonly helixBaseUrl: string;
  readonly eventSubUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userId: string;
  readonly login: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdSubscriptions: () => ReadonlyArray<MockSubscription>;
  readonly deletedSubscriptions: () => ReadonlyArray<string>;
  readonly tokenRequests: () => ReadonlyArray<string>;
  readonly emitRedemption: (redemption: MockRedemption) => boolean;
  /** Send an EventSub notification with `event` to every subscription of `type`. */
  readonly emit: (type: string, event: Readonly<Record<string, unknown>>) => boolean;
  readonly close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const text = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const timestamp = (): string => new Date().toISOString();

const envelope = (subscription: MockSubscription, event: unknown) => ({
  metadata: {
    message_id: "message-" + randomUUID(),
    message_timestamp: timestamp(),
    message_type: "notification",
    subscription_type: subscription.type,
    subscription_version: subscription.version,
  },
  payload: {
    subscription: {
      id: subscription.id,
      status: "enabled",
      type: subscription.type,
      version: subscription.version,
      condition: subscription.condition,
      transport: { method: "websocket", session_id: subscription.sessionId },
      created_at: subscription.createdAt,
      cost: 0,
    },
    event,
  },
});

const notification = (subscription: MockSubscription, redemption: MockRedemption) => {
  const rewardId = redemption.rewardId ?? subscription.condition["reward_id"] ?? "reward-1";
  return {
    metadata: {
      message_id: "message-" + randomUUID(),
      message_timestamp: timestamp(),
      message_type: "notification",
      subscription_type: subscription.type,
      subscription_version: subscription.version,
    },
    payload: {
      subscription: {
        id: subscription.id,
        status: "enabled",
        type: subscription.type,
        version: subscription.version,
        condition: subscription.condition,
        transport: { method: "websocket", session_id: subscription.sessionId },
        created_at: subscription.createdAt,
        cost: 0,
      },
      event: {
        id: "redemption-" + randomUUID(),
        broadcaster_user_id: subscription.condition["broadcaster_user_id"] ?? "1337",
        broadcaster_user_login: "streamer",
        broadcaster_user_name: "Streamer",
        user_id: redemption.userId ?? "9001",
        user_login: "viewer",
        user_name: "Viewer",
        user_input: "",
        status: "unfulfilled",
        reward: {
          id: rewardId,
          title: redemption.title,
          cost: 100,
          prompt: "Use the reward",
        },
        redeemed_at: timestamp(),
      },
    },
  };
};

/**
 * A local-mode Twitch stand-in: OAuth token/validate endpoints, Helix EventSub
 * subscription creation, and an EventSub WebSocket session that can emit a
 * channel-points redemption on demand.
 */
export const startMockTwitchServer = async (
  options: MockTwitchServerOptions = {},
): Promise<MockTwitchServer> => {
  const clientId = options.clientId ?? "mock-client-id";
  const clientSecret = options.clientSecret ?? "mock-client-secret";
  const userId = options.userId ?? "1337";
  const login = options.login ?? "streamer";
  const scopes = options.scopes ?? ["channel:read:redemptions", "user:read:email"];

  const subscriptions = new Map<string, MockSubscription>();
  const deleted: Array<string> = [];
  const tokenRequests: Array<string> = [];
  const sessions = new Map<string, WebSocket>();
  let demoEmit: (redemption: MockRedemption) => boolean = () => false;

  const http: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);

      if (request.method === "POST" && url.pathname === "/oauth2/token") {
        tokenRequests.push(body);
        json(response, 200, {
          access_token: "mock-access-token",
          refresh_token: "mock-refresh-token",
          expires_in: 3600,
          scope: scopes,
          token_type: "bearer",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/oauth2/device") {
        json(response, 200, {
          device_code: "mock-device-code",
          user_code: "ABCD1234",
          verification_uri: "https://www.twitch.tv/activate",
          expires_in: 1800,
          interval: 0,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/oauth2/validate") {
        json(response, 200, {
          client_id: clientId,
          login,
          scopes,
          user_id: userId,
          expires_in: 3600,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/helix/users") {
        json(response, 200, {
          data: [
            {
              id: userId,
              login,
              display_name: "Streamer",
              type: "",
              broadcaster_type: "",
              description: "",
              profile_image_url: "https://example.com/profile.png",
              offline_image_url: "https://example.com/offline.png",
              view_count: 0,
              created_at: "2020-01-01T00:00:00Z",
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/helix/eventsub/subscriptions") {
        const parsed: unknown = JSON.parse(body);
        if (!isRecord(parsed)) {
          json(response, 400, { message: "invalid body" });
          return;
        }
        const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
        const version = typeof parsed["version"] === "string" ? parsed["version"] : "1";
        const condition = isRecord(parsed["condition"]) ? parsed["condition"] : {};
        const transport = isRecord(parsed["transport"]) ? parsed["transport"] : {};
        const sessionId =
          typeof transport["session_id"] === "string" ? transport["session_id"] : "";
        if (sessionId === "" || !sessions.has(sessionId)) {
          json(response, 400, { message: "unknown websocket session" });
          return;
        }
        const conditionRecord: Record<string, string> = {};
        for (const [key, value] of Object.entries(condition)) {
          if (typeof value === "string") conditionRecord[key] = value;
        }
        const subscription: MockSubscription = {
          id: "sub-" + (subscriptions.size + 1),
          type,
          version,
          condition: conditionRecord,
          sessionId,
          status: "enabled",
          createdAt: timestamp(),
        };
        subscriptions.set(subscription.id, subscription);
        json(response, 202, {
          data: [
            {
              id: subscription.id,
              status: subscription.status,
              type: subscription.type,
              version: subscription.version,
              condition: subscription.condition,
              created_at: subscription.createdAt,
              transport: { method: "websocket", session_id: sessionId },
              cost: 0,
            },
          ],
          total: 1,
          total_cost: 0,
          max_total_cost: 10,
        });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/helix/eventsub/subscriptions") {
        const id = url.searchParams.get("id");
        if (id !== null) {
          deleted.push(id);
          subscriptions.delete(id);
        }
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/helix/chat/messages") {
        json(response, 200, {
          data: [{ message_id: "message-1", is_sent: true }],
        });
        return;
      }

      if (url.pathname === "/demo/redeem") {
        const title = url.searchParams.get("title") ?? "Hydrate";
        json(response, 200, { sent: demoEmit({ title }) });
        return;
      }

      text(response, 404, "not found");
    })().catch((cause: unknown) => {
      text(
        response,
        500,
        cause instanceof Error ? cause.message : String(cause),
      );
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  let nextSession = 1;

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket);
    });
  });

  wss.on("connection", (socket) => {
    const sessionId = "session-" + nextSession++;
    sessions.set(sessionId, socket);
    socket.on("close", () => {
      sessions.delete(sessionId);
    });
    socket.send(
      JSON.stringify({
        metadata: {
          message_id: "welcome-" + randomUUID(),
          message_timestamp: timestamp(),
          message_type: "session_welcome",
        },
        payload: {
          session: {
            id: sessionId,
            status: "connected",
            connected_at: timestamp(),
            keepalive_timeout_seconds: 30,
            reconnect_url: null,
          },
        },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });

  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock Twitch server did not bind a TCP port");
  }
  const base = "http://127.0.0.1:" + address.port;

  let closed = false;

  const emitRedemption = (redemption: MockRedemption): boolean => {
    let sent = false;
    for (const subscription of subscriptions.values()) {
      if (subscription.type !== "channel.channel_points_custom_reward_redemption.add") {
        continue;
      }
      const socket = sessions.get(subscription.sessionId);
      if (socket === undefined) continue;
      socket.send(JSON.stringify(notification(subscription, redemption)));
      sent = true;
    }
    return sent;
  };

  demoEmit = emitRedemption;

  const emit = (type: string, event: Readonly<Record<string, unknown>>): boolean => {
    let sent = false;
    for (const subscription of subscriptions.values()) {
      if (subscription.type !== type) continue;
      const socket = sessions.get(subscription.sessionId);
      if (socket === undefined) continue;
      socket.send(JSON.stringify(envelope(subscription, event)));
      sent = true;
    }
    return sent;
  };

  return {
    idBaseUrl: base,
    helixBaseUrl: base + "/helix",
    eventSubUrl: base.replace("http:", "ws:") + "/ws",
    clientId,
    clientSecret,
    userId,
    login,
    scopes,
    createdSubscriptions: () => [...subscriptions.values()],
    deletedSubscriptions: () => [...deleted],
    tokenRequests: () => [...tokenRequests],
    emitRedemption,
    emit,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sessions.values()) socket.terminate();
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
};

/** Write the token file a real `ballast auth` run would leave behind. */
export const seedMockTwitchAccount = async (input: {
  readonly dataDir: string;
  readonly slot: string;
  readonly server: MockTwitchServer;
}): Promise<void> => {
  await Effect.runPromise(
    writeStoredTwitchAccount(
      {
        version: 1,
        slot: input.slot,
        clientId: input.server.clientId,
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3_600_000,
        scopes: input.server.scopes,
        userId: input.server.userId,
        login: input.server.login,
      },
      input.dataDir,
    ).pipe(Effect.provide([NodeServices.layer, NodeCrypto.layer])),
  );
};
