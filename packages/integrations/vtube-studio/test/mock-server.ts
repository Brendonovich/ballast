import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

export interface MockVtsRequest {
  readonly connection: number;
  readonly socket: WebSocket;
  readonly messageType: string;
  readonly requestType: string;
  readonly requestID: string | undefined;
  readonly data: Record<string, unknown>;
}

export type MockVtsReply =
  | { readonly type: "data"; readonly data?: Record<string, unknown> }
  | { readonly type: "error"; readonly errorID: number; readonly message: string }
  | { readonly type: "ignore" };

export type MockVtsHandler = (request: MockVtsRequest) => MockVtsReply;

export interface MockVtsServer {
  readonly url: string;
  readonly server: WebSocketServer;
  readonly requests: () => ReadonlyArray<MockVtsRequest>;
  readonly connections: () => number;
  readonly sendEvent: (messageType: string, data: Record<string, unknown>) => void;
  readonly reply: (request: MockVtsRequest, data: Record<string, unknown>) => void;
  readonly replyError: (request: MockVtsRequest, errorID: number, message: string) => void;
  readonly closeClients: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const packet = (requestID: string | undefined, messageType: string, data: unknown) => ({
  apiName: "VTubeStudioPublicAPI",
  apiVersion: "1.0",
  timestamp: Date.now(),
  ...(requestID === undefined ? {} : { requestID }),
  messageType,
  data,
});

/**
 * A small VTube Studio WebSocket server for driver tests. It answers
 * `<type>Request` with `<type>Response` and lets a test hold, reply to or
 * fail individual requests, push events and drop clients.
 */
export const startMockVtsServer = (
  handler: MockVtsHandler,
): Effect.Effect<MockVtsServer, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<MockVtsServer>((resolve, reject) => {
          const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
          const requests: Array<MockVtsRequest> = [];
          let connectionCount = 0;

          const send = (socket: WebSocket, message: unknown): void => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
          };

          const reply = (request: MockVtsRequest, data: Record<string, unknown>): void => {
            send(
              request.socket,
              packet(request.requestID, request.requestType + "Response", data),
            );
          };

          const replyError = (
            request: MockVtsRequest,
            errorID: number,
            message: string,
          ): void => {
            send(request.socket, packet(request.requestID, "APIError", { errorID, message }));
          };

          const sendEvent = (messageType: string, data: Record<string, unknown>): void => {
            for (const client of server.clients) {
              send(client, packet(undefined, messageType, data));
            }
          };

          server.on("connection", (socket) => {
            connectionCount += 1;
            const connection = connectionCount;
            socket.on("message", (raw) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw.toString());
              } catch {
                return;
              }
              if (!isRecord(parsed)) return;
              const messageType = parsed["messageType"];
              if (typeof messageType !== "string") return;
              const requestType = messageType.endsWith("Request")
                ? messageType.slice(0, -"Request".length)
                : messageType;
              const requestID = parsed["requestID"];
              const data = parsed["data"];
              const request: MockVtsRequest = {
                connection,
                socket,
                messageType,
                requestType,
                requestID: typeof requestID === "string" ? requestID : undefined,
                data: isRecord(data) ? data : {},
              };
              requests.push(request);

              const result = handler(request);
              switch (result.type) {
                case "data":
                  reply(request, result.data ?? {});
                  break;
                case "error":
                  replyError(request, result.errorID, result.message);
                  break;
                case "ignore":
                  break;
              }
            });
          });

          server.on("error", reject);
          server.on("listening", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Mock VTube Studio server has no port"));
              return;
            }
            resolve({
              url: "ws://127.0.0.1:" + address.port,
              server,
              requests: () => requests,
              connections: () => connectionCount,
              sendEvent,
              reply,
              replyError,
              closeClients: () => {
                for (const client of server.clients) client.terminate();
              },
            });
          });
        }),
      catch: (cause) => new Error("Could not start the mock VTube Studio server: " + String(cause)),
    }),
    (mock) =>
      Effect.sync(() => {
        for (const client of mock.server.clients) client.terminate();
        mock.server.close();
      }),
  );
