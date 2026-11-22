import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export interface MockObsServerOptions {
  readonly password?: string;
  readonly scenes?: ReadonlyArray<string>;
  /** Fixed port for reconnect tests; defaults to an ephemeral port. */
  readonly port?: number;
}

export interface MockObsServer {
  readonly url: string;
  readonly port: number;
  readonly currentScene: () => string;
  readonly requests: () => ReadonlyArray<string>;
  readonly emit: (eventType: string, data: unknown) => void;
  readonly close: () => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const authString = (password: string, salt: string, challenge: string): string => {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
};

const uuidFor = (scene: string): string => "uuid-" + scene.replaceAll(" ", "-");

/**
 * A minimal obs-websocket v5 server: Hello/Identify with optional auth,
 * request/response correlation for the scene requests the agent uses, and
 * event pushes. It is intentionally not a full OBS emulator.
 */
export const startMockObsServer = async (
  options: MockObsServerOptions = {},
): Promise<MockObsServer> => {
  const scenes = options.scenes ?? ["Scene 1", "Scene 2"];
  let currentScene = scenes[0] ?? "Scene 1";
  const requests: string[] = [];
  const clients = new Set<WebSocket>();

  const send = (socket: WebSocket, packet: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(packet));
    }
  };

  const broadcastEvent = (eventType: string, data: unknown): void => {
    for (const client of clients) {
      send(client, {
        op: 5,
        d: { eventType, eventIntent: 1 << 2, eventData: data },
      });
    }
  };

  const http = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (socket) => {
    clients.add(socket);
    const salt = randomBytes(16).toString("base64");
    const challenge = randomBytes(16).toString("base64");
    let identified = false;

    send(socket, {
      op: 0,
      d: {
        obsWebSocketVersion: "5.7.0",
        rpcVersion: 1,
        ...(options.password === undefined
          ? {}
          : { authentication: { challenge, salt } }),
      },
    });

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      const op = parsed["op"];
      const d = isRecord(parsed["d"]) ? parsed["d"] : {};

      if (op === 1) {
        if (options.password !== undefined) {
          const authentication =
            typeof d["authentication"] === "string" ? d["authentication"] : undefined;
          if (authentication !== authString(options.password, salt, challenge)) {
            socket.close(4009, "Authentication failed");
            return;
          }
        }
        identified = true;
        send(socket, { op: 2, d: { negotiatedRpcVersion: 1 } });
        return;
      }

      if (!identified || op !== 6) return;

      const requestType = typeof d["requestType"] === "string" ? d["requestType"] : "";
      const requestId = typeof d["requestId"] === "string" ? d["requestId"] : "";
      const requestData = isRecord(d["requestData"]) ? d["requestData"] : {};
      requests.push(requestType);

      const respond = (responseData?: unknown): void => {
        send(socket, {
          op: 7,
          d: {
            requestType,
            requestId,
            requestStatus: { result: true, code: 100 },
            ...(responseData === undefined ? {} : { responseData }),
          },
        });
      };

      const fail = (code: number, comment: string): void => {
        send(socket, {
          op: 7,
          d: {
            requestType,
            requestId,
            requestStatus: { result: false, code, comment },
          },
        });
      };

      switch (requestType) {
        case "GetSceneList":
          respond({
            currentProgramSceneName: currentScene,
            currentProgramSceneUuid: uuidFor(currentScene),
            currentPreviewSceneName: null,
            currentPreviewSceneUuid: null,
            scenes: scenes.map((scene, index) => ({
              sceneName: scene,
              sceneIndex: index,
              sceneUuid: uuidFor(scene),
            })),
          });
          return;
        case "SetCurrentProgramScene": {
          const requested =
            typeof requestData["sceneName"] === "string"
              ? requestData["sceneName"]
              : undefined;
          if (requested === undefined || !scenes.includes(requested)) {
            fail(600, "No scene named " + String(requested));
            return;
          }
          currentScene = requested;
          respond({});
          broadcastEvent("CurrentProgramSceneChanged", {
            sceneName: currentScene,
            sceneUuid: uuidFor(currentScene),
          });
          return;
        }
        case "GetVersion":
          respond({
            obsVersion: "31.0.0",
            obsWebSocketVersion: "5.7.0",
            rpcVersion: 1,
            availableRequests: [],
            supportedImageFormats: [],
            platform: "mock",
          });
          return;
        case "Reidentify":
          respond({});
          return;
        default:
          fail(204, 'Mock OBS does not implement "' + requestType + '"');
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock OBS server did not bind a TCP port");
  }
  const port = address.port;
  let closed = false;

  return {
    url: "ws://127.0.0.1:" + port,
    port,
    currentScene: () => currentScene,
    requests: () => [...requests],
    emit: broadcastEvent,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of clients) client.terminate();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
};
