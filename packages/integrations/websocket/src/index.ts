import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { encodeBase64 } from "./base64.ts";
import { INTEGRATION } from "./constants.ts";
import type { Integration } from "./constants.ts";
import type {
  WebSocketBroadcastResult,
  WebSocketClientDisconnected,
  WebSocketClientInfo,
  WebSocketClose,
  WebSocketJsonTopic,
  WebSocketMessage,
  WebSocketOpen,
  WebSocketOutboundMessage,
  WebSocketServerMessage,
} from "./types.ts";

export { INTEGRATION } from "./constants.ts";
export type * from "./types.ts";
export { decodeBase64, encodeBase64 } from "./base64.ts";

const MessageSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Uint8Array),
  receivedAt: Schema.Number,
});

const OpenSchema = Schema.Struct({
  url: Schema.String,
  connectedAt: Schema.Number,
});

const CloseSchema = Schema.Struct({
  code: Schema.Number,
  reason: Schema.optionalKey(Schema.String),
  willReconnect: Schema.Boolean,
  at: Schema.Number,
});

const ClientInfoSchema = Schema.Struct({
  clientId: Schema.String,
  connectedAt: Schema.Number,
});

const ClientDisconnectedSchema = Schema.Struct({
  clientId: Schema.String,
  code: Schema.Number,
  reason: Schema.optionalKey(Schema.String),
  cause: Schema.Literals(["peer", "server", "error"]),
  at: Schema.Number,
});

const ServerMessageSchema = Schema.Struct({
  clientId: Schema.String,
  text: Schema.optionalKey(Schema.String),
  binary: Schema.optionalKey(Schema.Uint8Array),
  receivedAt: Schema.Number,
});

const AckSchema = Schema.Struct({});

const OutboundSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("binary"), base64: Schema.String }),
  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
]);

const BroadcastResultSchema = Schema.Struct({
  delivered: Schema.Number,
  failed: Schema.Number,
});

const connectScope = (url: string | undefined): string => {
  if (url === undefined) return "ws:connect:*";
  try {
    return "ws:connect:" + new URL(url).host;
  } catch {
    return "ws:connect:*";
  }
};

const listenScope = (options: { host?: string; port?: number; path?: string }): string => {
  if (options.port === undefined) return "ws:listen:*";
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "";
  return "ws:listen:" + host + ":" + String(options.port) + path;
};

/** Declare a WebSocket client slot. The URL and handshake live in connection config. */
export interface ClientOptions {
  /**
   * Optional URL override, for scripts that must hard-code a development
   * server. Prefer connection config. Recording it here makes the host appear
   * in the manifest.
   */
  readonly url?: string;
}

export interface WebSocketClient extends Ballast.ConnectionRef<Integration> {
  /** The URL declared in the script, if any. */
  readonly url: string | undefined;
}

export const Client = (
  slot: string,
  options: ClientOptions = {},
): Effect.Effect<WebSocketClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "local",
    });

    // A request-shaped capability keeps the consent UI honest: it shows the
    // host this slot may connect to even though the driver reads config.
    yield* Ballast.Request<Record<string, never>, Record<string, never>>({
      integration: INTEGRATION,
      slot,
      request: "websocket/connect",
      scopes: [connectScope(options.url)],
      inputSchema: AckSchema,
      outputSchema: AckSchema,
    });

    return { ...connection, url: options.url };
  });

export interface WebSocketSender {
  readonly send: (message: WebSocketOutboundMessage) => Effect.Effect<void>;
  readonly text: (text: string) => Effect.Effect<void>;
  readonly binary: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly json: (value: unknown) => Effect.Effect<void>;
}

const sendMessage = (message: WebSocketOutboundMessage): WebSocketOutboundMessage => message;

/** Declare permission to send frames on a client slot. */
export const Send = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<WebSocketSender, never, Ballast.RequestHost> =>
  Ballast.Request<WebSocketOutboundMessage, Record<string, never>>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "websocket/send",
    inputSchema: OutboundSchema,
    outputSchema: AckSchema,
  }).pipe(
    Effect.map((client) => ({
      send: (message) => client(sendMessage(message)).pipe(Effect.asVoid),
      text: (text) => client({ type: "text", text }).pipe(Effect.asVoid),
      binary: (bytes) =>
        client({ type: "binary", base64: encodeBase64(bytes) }).pipe(Effect.asVoid),
      json: (value) => client({ type: "json", value }).pipe(Effect.asVoid),
    })),
  );

export interface ServerOptions {
  readonly host?: string;
  /** Recorded as the listen capability; the connection config may override it. */
  readonly port?: number;
  readonly path?: string;
}

export interface WebSocketServer extends Ballast.ConnectionRef<Integration> {
  readonly port: number | undefined;
  readonly path: string | undefined;
}

/** Declare a local WebSocket server slot. */
export const Server = (
  slot: string,
  options: ServerOptions = {},
): Effect.Effect<WebSocketServer, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "local",
    });

    yield* Ballast.Request<Record<string, never>, Record<string, never>>({
      integration: INTEGRATION,
      slot,
      request: "websocket/listen",
      scopes: [listenScope(options)],
      inputSchema: AckSchema,
      outputSchema: AckSchema,
    });

    return { ...connection, port: options.port, path: options.path };
  });

export interface WebSocketServerSender {
  readonly toClient: (clientId: string, message: WebSocketOutboundMessage) => Effect.Effect<void>;
  readonly sendToClient: (clientId: string, message: WebSocketOutboundMessage) => Effect.Effect<void>;
  readonly broadcast: (message: WebSocketOutboundMessage) => Effect.Effect<WebSocketBroadcastResult>;
  readonly text: (clientId: string, text: string) => Effect.Effect<void>;
  readonly binary: (clientId: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly json: (clientId: string, value: unknown) => Effect.Effect<void>;
  readonly broadcastText: (text: string) => Effect.Effect<WebSocketBroadcastResult>;
  readonly broadcastBinary: (bytes: Uint8Array) => Effect.Effect<WebSocketBroadcastResult>;
  readonly broadcastJson: (value: unknown) => Effect.Effect<WebSocketBroadcastResult>;
}

/** Declare permission to send to one client or every client on a server slot. */
export const ServerSend = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<WebSocketServerSender, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const toClientSchema = Schema.Struct({
      clientId: Schema.String,
      message: OutboundSchema,
    });
    const toClient = yield* Ballast.Request<
      { readonly clientId: string; readonly message: WebSocketOutboundMessage },
      Record<string, never>
    >({
      integration: INTEGRATION,
      slot: connection.slot,
      request: "websocket/sendToClient",
      inputSchema: toClientSchema,
      outputSchema: AckSchema,
    });
    const broadcast = yield* Ballast.Request<
      WebSocketOutboundMessage,
      WebSocketBroadcastResult
    >({
      integration: INTEGRATION,
      slot: connection.slot,
      request: "websocket/broadcast",
      inputSchema: OutboundSchema,
      outputSchema: BroadcastResultSchema,
    });

    const toClientMessage = (clientId: string, message: WebSocketOutboundMessage) =>
      toClient({ clientId, message }).pipe(Effect.asVoid);

    return {
      toClient: toClientMessage,
      sendToClient: toClientMessage,
      broadcast,
      text: (clientId, text) => toClientMessage(clientId, { type: "text", text }),
      binary: (clientId, bytes) =>
        toClientMessage(clientId, { type: "binary", base64: encodeBase64(bytes) }),
      json: (clientId, value) => toClientMessage(clientId, { type: "json", value }),
      broadcastText: (text) => broadcast({ type: "text", text }),
      broadcastBinary: (bytes) => broadcast({ type: "binary", base64: encodeBase64(bytes) }),
      broadcastJson: (value) => broadcast({ type: "json", value }),
    };
  });

/** A frame received by a client slot. */
export const Message = Ballast.Topic<WebSocketMessage, Integration>({
  integration: INTEGRATION,
  topic: "websocket/message",
  schema: MessageSchema,
});

/** The client slot connected (emitted again after every reconnect). */
export const Open = Ballast.Topic<WebSocketOpen, Integration>({
  integration: INTEGRATION,
  topic: "websocket/open",
  schema: OpenSchema,
});

/** The client slot disconnected. */
export const Close = Ballast.Topic<WebSocketClose, Integration>({
  integration: INTEGRATION,
  topic: "websocket/close",
  schema: CloseSchema,
});

/** A frame received from one server client. */
export const ServerMessage = Ballast.Topic<WebSocketServerMessage, Integration>({
  integration: INTEGRATION,
  topic: "websocket/server/message",
  schema: ServerMessageSchema,
});

/** A local server accepted a client. */
export const ClientConnected = Ballast.Topic<WebSocketClientInfo, Integration>({
  integration: INTEGRATION,
  topic: "websocket/server/client.connected",
  schema: ClientInfoSchema,
});

/** A local server lost a client. */
export const ClientDisconnected = Ballast.Topic<WebSocketClientDisconnected, Integration>({
  integration: INTEGRATION,
  topic: "websocket/server/client.disconnected",
  schema: ClientDisconnectedSchema,
});

const decodeJson = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  message: WebSocketMessage,
): Effect.Effect<A | undefined> => {
  const text =
    message.text ??
    (message.binary === undefined ? undefined : new TextDecoder().decode(message.binary));
  if (text === undefined) return Effect.succeed(undefined);

  return Effect.sync(() => {
    try {
      const parsed: unknown = JSON.parse(text);
      const decoded = Schema.decodeUnknownOption(schema)(parsed);
      return decoded._tag === "Some" ? decoded.value : undefined;
    } catch {
      return undefined;
    }
  });
};

/**
 * Decode JSON frames with a user-provided schema. Invalid JSON or schema
 * mismatches are logged and skipped, so one bad frame cannot stop the handler.
 */
export const Json = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
): WebSocketJsonTopic<A> => {
  const base = Ballast.Topic<WebSocketMessage, Integration>({
    integration: INTEGRATION,
    topic: "websocket/message",
    schema: MessageSchema,
  });

  return {
    integration: base.integration,
    topic: base.topic,
    schema,
    subscribe: (name, connection, handler) =>
      base.subscribe(
        name,
        // The base topic only needs the slot; callers pass a connection handle.
        { ...connection, integration: INTEGRATION, location: "local" },
        (message) =>
          Effect.gen(function* () {
            const decoded = yield* decodeJson(schema, message);
            if (decoded === undefined) {
              yield* Effect.logWarning(
                "websocket/" + connection.slot + " skipped a frame that did not match the JSON schema",
              );
              return;
            }
            yield* handler(decoded);
          }),
      ),
  };
};
