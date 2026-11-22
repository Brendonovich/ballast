import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { layerFromFunction } from "../src/eventsub/registrar.ts";
import { make as makeSocket } from "../src/eventsub/socket.ts";
import { subscriptionRequest } from "../src/eventsub/subscriptions.ts";

interface TestServer {
  readonly url: string;
  readonly server: WebSocketServer;
  readonly connections: () => number;
}

const startServer = (
  onConnection: (socket: WebSocket, connection: number) => void,
): Effect.Effect<TestServer, Error, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<TestServer>((resolve, reject) => {
          const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          let count = 0;
          server.on("error", reject);
          server.on("listening", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("No WebSocket port"));
              return;
            }
            server.on("connection", (socket) => {
              count += 1;
              onConnection(socket, count);
            });
            resolve({
              url: "ws://127.0.0.1:" + address.port,
              server,
              connections: () => count,
            });
          });
        }),
      catch: (cause) => new Error(String(cause)),
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );

const timestamp = () => new Date().toISOString();

const welcome = (sessionId: string, keepaliveTimeoutSeconds: number) => ({
  metadata: {
    message_id: "welcome-" + sessionId,
    message_timestamp: timestamp(),
    message_type: "session_welcome",
  },
  payload: {
    session: {
      id: sessionId,
      status: "connected",
      connected_at: timestamp(),
      keepalive_timeout_seconds: keepaliveTimeoutSeconds,
      reconnect_url: null,
    },
  },
});

const keepalive = () => ({
  metadata: {
    message_id: "keepalive-" + Math.random(),
    message_timestamp: timestamp(),
    message_type: "session_keepalive",
  },
  payload: {},
});

const reconnect = (url: string) => ({
  metadata: {
    message_id: "reconnect-1",
    message_timestamp: timestamp(),
    message_type: "session_reconnect",
  },
  payload: {
    session: {
      id: "session-reconnect",
      status: "reconnecting",
      connected_at: timestamp(),
      keepalive_timeout_seconds: 10,
      reconnect_url: url,
    },
  },
});

const redemption = (messageId: string, redemptionId: string) => ({
  metadata: {
    message_id: messageId,
    message_timestamp: timestamp(),
    message_type: "notification",
    subscription_type: "channel.channel_points_custom_reward_redemption.add",
    subscription_version: "1",
  },
  payload: {
    subscription: {
      id: "sub-1",
      status: "enabled",
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: "1337" },
      transport: { method: "websocket", session_id: "session-1" },
      created_at: timestamp(),
      cost: 0,
    },
    event: {
      id: redemptionId,
      broadcaster_user_id: "1337",
      broadcaster_user_login: "cool_user",
      broadcaster_user_name: "Cool_User",
      user_id: "9001",
      user_login: "cooler_user",
      user_name: "Cooler_User",
      user_input: "pogchamp",
      status: "unfulfilled",
      reward: {
        id: "reward-1",
        title: redemptionId,
        cost: 100,
        prompt: "reward prompt",
      },
      redeemed_at: "2020-07-15T17:16:03.17106713Z",
    },
  },
});

const send = (socket: WebSocket, message: unknown) => socket.send(JSON.stringify(message));

const subscription = subscriptionRequest(
  "channel.channel_points_custom_reward_redemption.add",
  { broadcaster_user_id: "1337" },
);

const config = {
  subscriptions: [subscription],
  handshakeTimeout: "2 seconds",
  keepaliveGrace: "100 millis",
  reconnectDelay: "10 millis",
} as const;

describe("EventSub WebSocket client", () => {
  it.live("welcomes, creates subscriptions, dedupes and follows session_reconnect", () =>
    Effect.gen(function* () {
      const second = yield* startServer((socket) => {
        send(socket, welcome("session-2", 10));
        send(socket, redemption("message-2", "redemption-2"));
      });

      const first = yield* startServer((socket) => {
        send(socket, welcome("session-1", 10));
        send(socket, redemption("message-1", "redemption-1"));
        send(socket, redemption("message-1", "redemption-1"));
        send(socket, keepalive());
        send(socket, reconnect(second.url));
      });

      const registrations = yield* Ref.make<ReadonlyArray<{ sessionId: string; type: string }>>([]);
      const registrar = layerFromFunction((sessionId, request) =>
        Ref.update(registrations, (current) => [
          ...current,
          { sessionId, type: request.type },
        ]),
      );

      const program = Effect.gen(function* () {
        const socket = yield* makeSocket({ ...config, url: first.url });
        const notifications = yield* socket.notifications.pipe(
          Stream.take(2),
          Stream.runCollect,
        );
        return {
          notifications: Array.from(notifications),
          sessionId: yield* socket.sessionId,
          registrations: yield* Ref.get(registrations),
        };
      });

      const result = yield* program.pipe(
        Effect.provide(Layer.mergeAll(Socket.layerWebSocketConstructorGlobal, registrar)),
      );

      expect(result.notifications.map((notification) => notification.type)).toEqual([
        "channel.channel_points_custom_reward_redemption.add",
        "channel.channel_points_custom_reward_redemption.add",
      ]);
      const [firstNotification, secondNotification] = result.notifications;
      if (
        firstNotification?.type !==
          "channel.channel_points_custom_reward_redemption.add" ||
        secondNotification?.type !==
          "channel.channel_points_custom_reward_redemption.add"
      ) {
        return;
      }
      expect(firstNotification.payload.reward.title).toBe("redemption-1");
      expect(secondNotification.payload.reward.title).toBe("redemption-2");
      expect(result.sessionId).toBe("session-2");
      expect(result.registrations).toEqual([
        { sessionId: "session-1", type: "channel.channel_points_custom_reward_redemption.add" },
      ]);
      expect(second.connections()).toBe(1);
    }),
  );

  it.live("reconnects when the keepalive timeout elapses", () =>
    Effect.gen(function* () {
      const server = yield* startServer((socket, connection) => {
        send(socket, welcome("session-" + Math.random(), 0.1));
        if (connection > 1) {
          send(socket, redemption("message-after-timeout", "redemption-after-timeout"));
        }
      });

      const registrar = layerFromFunction(() => Effect.void);

      const program = Effect.gen(function* () {
        const socket = yield* makeSocket({
          ...config,
          url: server.url,
          keepaliveGrace: "10 millis",
        });
        const notifications = yield* socket.notifications.pipe(Stream.take(1), Stream.runCollect);
        return Array.from(notifications);
      });

      const notifications = yield* program.pipe(
        Effect.provide(Layer.mergeAll(Socket.layerWebSocketConstructorGlobal, registrar)),
      );

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.messageId).toBe("message-after-timeout");
      expect(server.connections()).toBeGreaterThanOrEqual(2);
    }),
  );
});
