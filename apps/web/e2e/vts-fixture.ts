import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

/**
 * Minimal VTube Studio fixture: answers APIState so the driver reaches its
 * AuthenticationToken request, then deliberately leaves that request pending.
 * That is the exact "waiting for the user to allow the plugin" state.
 */
const packet = (
  requestID: string | undefined,
  messageType: string,
  data: Record<string, unknown>,
) => ({
  apiName: "VTubeStudioPublicAPI",
  apiVersion: "1.0",
  timestamp: Date.now(),
  ...(requestID === undefined ? {} : { requestID }),
  messageType,
  data,
});

const send = (socket: WebSocket, message: unknown): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
};

export interface VtsFixture {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const startVtsFixture = (): Promise<VtsFixture> =>
  new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== "object") return;
        const messageType = "messageType" in parsed ? parsed.messageType : undefined;
        if (messageType !== "APIStateRequest") return;
        const requestID = "requestID" in parsed && typeof parsed.requestID === "string" ? parsed.requestID : undefined;
        send(socket, packet(requestID, "APIStateResponse", {
          active: true,
          vTubeStudioVersion: "1.30.0",
          currentSessionAuthenticated: false,
        }));
        // AuthenticationTokenRequest is intentionally ignored: the user has
        // not clicked Allow in VTube Studio yet.
      });
    });
    server.on("error", reject);
    server.on("listening", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("VTube Studio fixture has no port"));
        return;
      }
      resolve({
        url: "ws://127.0.0.1:" + address.port,
        close: () =>
          new Promise((resolveClose) => {
            for (const client of server.clients) client.terminate();
            server.close(() => resolveClose());
          }),
      });
    });
  });
