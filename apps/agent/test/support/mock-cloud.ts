import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  ReconcileSubscriptionsRequest,
  RelayServerMessage,
  TwitchSubscription,
} from "@ballast/cloud-protocol";

export interface MockCloudOptions {
  readonly twitchUserId?: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly connectionId?: string;
  readonly machineId?: string;
  readonly machineToken?: string;
  readonly scopes?: ReadonlyArray<string>;
}

export interface MockCloudServer {
  readonly url: string;
  readonly twitchUserId: string;
  readonly connectionId: string;
  readonly machineId: string;
  readonly machineToken: string;
  readonly reconciled: () => ReadonlyArray<ReconcileSubscriptionsRequest>;
  readonly acks: () => ReadonlyArray<number>;
  readonly relayConnections: () => number;
  readonly emitRedemption: (title: string) => boolean;
  /** Drop the relay socket so the agent has to reconnect and replay. */
  readonly dropRelay: () => void;
  /** Fail GET /api/connections to simulate the cloud being unreachable. */
  readonly setFailConnections: (fail: boolean) => void;
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

const envelope = (input: {
  readonly connectionId: string;
  readonly title: string;
  readonly twitchUserId: string;
}) => {
  const now = Date.now();
  return {
    id: "twitch:" + randomUUID(),
    integration: "twitch",
    topic: "twitch/channel.channel_points_custom_reward_redemption.add",
    connectionId: input.connectionId,
    occurredAt: now,
    receivedAt: now,
    payload: {
      id: "redemption-" + randomUUID(),
      broadcaster_user_id: input.twitchUserId,
      broadcaster_user_login: "streamer",
      broadcaster_user_name: "Streamer",
      user_id: "9001",
      user_login: "viewer",
      user_name: "Viewer",
      user_input: "",
      status: "unfulfilled",
      reward: {
        id: "reward-1",
        title: input.title,
        cost: 100,
        prompt: "Use the reward",
      },
      redeemed_at: new Date().toISOString(),
    },
    onStale: "drop" as const,
    maxAgeMs: 60_000,
  };
};

/**
 * A stand-in for the Ballast cloud gateway: pairing claim, machine-authorized
 * token/reconcile/Helix routes, and a relay WebSocket that can push a Twitch
 * redemption envelope.
 */
export const startMockCloudServer = async (
  options: MockCloudOptions = {},
): Promise<MockCloudServer> => {
  const twitchUserId = options.twitchUserId ?? "1337";
  const login = options.login ?? "streamer";
  const displayName = options.displayName ?? "Streamer";
  const connectionId = options.connectionId ?? "conn-1";
  const machineId = options.machineId ?? "m_1";
  const machineToken = options.machineToken ?? "blst_m_mock";
  const scopes = options.scopes ?? ["channel:read:redemptions"];

  const reconciled: Array<ReconcileSubscriptionsRequest> = [];
  const acks: Array<number> = [];
  const sockets = new Set<WebSocket>();
  const queued: Array<RelayServerMessage> = [];
  let nextSeq = 1;
  let failConnections = false;

  const sendRelay = (message: RelayServerMessage): void => {
    const encoded = JSON.stringify(message);
    let delivered = false;
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(encoded);
        delivered = true;
      }
    }
    if (!delivered) queued.push(message);
  };

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization;
    return header === "Bearer " + machineToken;
  };

  const http: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);

      if (request.method === "POST" && url.pathname === "/api/pairing/claim") {
        const parsed: unknown = body.trim().length === 0 ? undefined : JSON.parse(body);
        const code = isRecord(parsed) && typeof parsed["code"] === "string" ? parsed["code"] : "";
        if (code === "") {
          json(response, 404, {
            error: { tag: "not_found", message: "Pairing code is invalid or has expired" },
          });
          return;
        }
        json(response, 200, {
          machineId,
          machineToken,
          user: { id: "user-1", login, displayName },
        });
        return;
      }

      if (url.pathname === "/demo/redeem") {
        const title = url.searchParams.get("title") ?? "Hydrate";
        const sent = sockets.size > 0;
        if (sent) {
          sendRelay({
            _tag: "event",
            seq: nextSeq++,
            envelope: envelope({ connectionId, title, twitchUserId }),
            stale: false,
          });
        }
        json(response, 200, { sent });
        return;
      }

      if (!authorized(request)) {
        json(response, 401, {
          error: { tag: "unauthorized", message: "Missing or invalid machine token" },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/connections") {
        if (failConnections) {
          json(response, 503, { error: { tag: "unavailable", message: "cloud offline" } });
          return;
        }
        json(response, 200, {
          connections: [
            {
              id: connectionId,
              twitchUserId,
              login,
              displayName,
              scopes,
              machineId,
              createdAt: Date.now(),
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tokens/twitch") {
        json(response, 200, {
          accessToken: "cloud-access-token",
          expiresAt: Date.now() + 3_600_000,
          scopes,
          twitchUserId,
          login,
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/twitch/subscriptions/reconcile"
      ) {
        const parsed: unknown = body.trim().length === 0 ? undefined : JSON.parse(body);
        if (!isRecord(parsed) || !Array.isArray(parsed["subscriptions"])) {
          json(response, 400, {
            error: { tag: "invalid_request", message: "Invalid reconcile body" },
          });
          return;
        }
        const specs: ReconcileSubscriptionsRequest = {
          connectionId:
            typeof parsed["connectionId"] === "string" ? parsed["connectionId"] : connectionId,
          subscriptions: parsed["subscriptions"].flatMap((spec: unknown) => {
            if (!isRecord(spec) || typeof spec["type"] !== "string") return [];
            const condition: Record<string, string> = {};
            if (isRecord(spec["condition"])) {
              for (const [key, value] of Object.entries(spec["condition"])) {
                if (typeof value === "string") condition[key] = value;
              }
            }
            return [
              {
                type: spec["type"],
                version: typeof spec["version"] === "number" ? spec["version"] : 1,
                condition,
                onStale: spec["onStale"] === "deliver" ? "deliver" : "drop",
                maxAgeMs: typeof spec["maxAgeMs"] === "number" ? spec["maxAgeMs"] : 60_000,
              },
            ];
          }),
        };
        reconciled.push(specs);
        const rows: Array<TwitchSubscription> = specs.subscriptions.map((spec, index) => ({
          id: "cloud-sub-" + (index + 1),
          providerSubscriptionId: "provider-sub-" + (index + 1),
          type: spec.type,
          version: spec.version,
          condition: spec.condition,
          status: "enabled",
          cost: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));
        json(response, 200, {
          subscriptions: rows,
          totalCost: rows.length,
          maxCost: 10,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/twitch/helix") {
        const parsed: unknown = body.trim().length === 0 ? undefined : JSON.parse(body);
        const path = isRecord(parsed) && typeof parsed["path"] === "string" ? parsed["path"] : "";
        const helixBody =
          path === "/helix/users"
            ? {
                data: [
                  {
                    id: twitchUserId,
                    login,
                    display_name: displayName,
                    type: "",
                    broadcaster_type: "",
                    description: "",
                    profile_image_url: "https://example.com/profile.png",
                    offline_image_url: "https://example.com/offline.png",
                    view_count: 0,
                    created_at: "2020-01-01T00:00:00Z",
                  },
                ],
              }
            : { data: [] };
        json(response, 200, { status: 200, body: helixBody, refreshed: false });
        return;
      }

      text(response, 404, "not found");
    })().catch((cause: unknown) => {
      text(response, 500, cause instanceof Error ? cause.message : String(cause));
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/relay/")) {
      socket.destroy();
      return;
    }
    const header = request.headers.authorization;
    if (header !== "Bearer " + machineToken) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket);
    });
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    connections += 1;
    socket.send(
      JSON.stringify({
        _tag: "hello",
        machineId,
        serverTime: Date.now(),
        pending: queued.length,
      }),
    );
    for (const message of queued.splice(0)) {
      socket.send(JSON.stringify(message));
    }
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      if (isRecord(parsed) && parsed["_tag"] === "ack" && Array.isArray(parsed["seqs"])) {
        for (const seq of parsed["seqs"]) {
          if (typeof seq === "number") acks.push(seq);
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });

  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock cloud did not bind a TCP port");
  }
  const url = "http://127.0.0.1:" + address.port;

  let closed = false;

  return {
    url,
    twitchUserId,
    connectionId,
    machineId,
    machineToken,
    reconciled: () => [...reconciled],
    acks: () => [...acks],
    setFailConnections: (fail) => {
      failConnections = fail;
    },
    relayConnections: () => connections,
    emitRedemption: (title: string): boolean => {
      sendRelay({
        _tag: "event",
        seq: nextSeq++,
        envelope: envelope({ connectionId, title, twitchUserId }),
        stale: false,
      });
      return true;
    },
    dropRelay: () => {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
};
