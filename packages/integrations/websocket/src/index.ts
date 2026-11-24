import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { encodeBase64 } from "./base64.ts";
import { CLIENT_INTEGRATION, SERVER_INTEGRATION } from "./constants.ts";
import type { ClientIntegration, ServerIntegration } from "./constants.ts";
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

export { CLIENT_INTEGRATION, SERVER_INTEGRATION } from "./constants.ts";
export type { ClientIntegration, ServerIntegration } from "./constants.ts";
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

export interface WebSocketSender {
  readonly send: (
    message: WebSocketOutboundMessage,
  ) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly text: (text: string) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly binary: (bytes: Uint8Array) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly json: (value: unknown) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
}

export interface WebSocketClient
  extends Ballast.ConnectionRef<ClientIntegration>, WebSocketSender {
  /** The URL declared in the script, if any. */
  readonly url: string | undefined;
}

const sendClient = (
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<ClientIntegration>,
): WebSocketSender => {
  const send = host.granted<WebSocketOutboundMessage, Record<string, never>>({
    integration: CLIENT_INTEGRATION,
    slot: connection.slot,
    request: "websocket/send",
    scopes: [],
    key: CLIENT_INTEGRATION + "/" + connection.slot + "/websocket/send",
    inputSchema: OutboundSchema,
    outputSchema: AckSchema,
  });
  return {
    send: (message) => send(message).pipe(Effect.asVoid),
    text: (text) => send({ type: "text", text }).pipe(Effect.asVoid),
    binary: (bytes) =>
      send({ type: "binary", base64: encodeBase64(bytes) }).pipe(Effect.asVoid),
    json: (value) => send({ type: "json", value }).pipe(Effect.asVoid),
  };
};

export const Client = (
  slot: string,
  options: ClientOptions = {},
): Effect.Effect<WebSocketClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<ClientIntegration>({
      integration: CLIENT_INTEGRATION,
      slot,
      location: "local",
      requests: ["websocket/*"],
    });
    const host = yield* Ballast.RequestHost;

    // A request-shaped capability keeps the consent UI honest: it shows the
    // host this slot may connect to even though the driver reads config.
    yield* Ballast.Request<Record<string, never>, Record<string, never>>({
      integration: CLIENT_INTEGRATION,
      slot,
      request: "websocket/connect",
      scopes: [connectScope(options.url)],
      inputSchema: AckSchema,
      outputSchema: AckSchema,
    });

    return { ...connection, url: options.url, ...sendClient(host, connection) };
  });

export interface ServerOptions {
  readonly host?: string;
  /** Recorded as the listen capability; the connection config may override it. */
  readonly port?: number;
  readonly path?: string;
}

export interface WebSocketServerSender {
  readonly send: (
    clientId: string,
    message: WebSocketOutboundMessage,
  ) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly broadcast: (
    message: WebSocketOutboundMessage,
  ) => Effect.Effect<WebSocketBroadcastResult, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly text: (
    clientId: string,
    text: string,
  ) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly binary: (
    clientId: string,
    bytes: Uint8Array,
  ) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly json: (
    clientId: string,
    value: unknown,
  ) => Effect.Effect<void, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly broadcastText: (
    text: string,
  ) => Effect.Effect<WebSocketBroadcastResult, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly broadcastBinary: (
    bytes: Uint8Array,
  ) => Effect.Effect<WebSocketBroadcastResult, Ballast.ConnectionRequestError, Ballast.Runtime>;
  readonly broadcastJson: (
    value: unknown,
  ) => Effect.Effect<WebSocketBroadcastResult, Ballast.ConnectionRequestError, Ballast.Runtime>;
}

export interface WebSocketServer
  extends Ballast.ConnectionRef<ServerIntegration>, WebSocketServerSender {
  readonly port: number | undefined;
  readonly path: string | undefined;
}

const sendServer = (
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<ServerIntegration>,
): WebSocketServerSender => {
  const toClientSchema = Schema.Struct({
    clientId: Schema.String,
    message: OutboundSchema,
  });
  const toClient = host.granted<
    { readonly clientId: string; readonly message: WebSocketOutboundMessage },
    Record<string, never>
  >({
    integration: SERVER_INTEGRATION,
    slot: connection.slot,
    request: "websocket/sendToClient",
    scopes: [],
    key: SERVER_INTEGRATION + "/" + connection.slot + "/websocket/sendToClient",
    inputSchema: toClientSchema,
    outputSchema: AckSchema,
  });
  const broadcast = host.granted<WebSocketOutboundMessage, WebSocketBroadcastResult>({
    integration: SERVER_INTEGRATION,
    slot: connection.slot,
    request: "websocket/broadcast",
    scopes: [],
    key: SERVER_INTEGRATION + "/" + connection.slot + "/websocket/broadcast",
    inputSchema: OutboundSchema,
    outputSchema: BroadcastResultSchema,
  });

  const send = (clientId: string, message: WebSocketOutboundMessage) =>
    toClient({ clientId, message }).pipe(Effect.asVoid);

  return {
    send,
    broadcast,
    text: (clientId, text) => send(clientId, { type: "text", text }),
    binary: (clientId, bytes) =>
      send(clientId, { type: "binary", base64: encodeBase64(bytes) }),
    json: (clientId, value) => send(clientId, { type: "json", value }),
    broadcastText: (text) => broadcast({ type: "text", text }),
    broadcastBinary: (bytes) => broadcast({ type: "binary", base64: encodeBase64(bytes) }),
    broadcastJson: (value) => broadcast({ type: "json", value }),
  };
};

/**
 * Declare a local WebSocket server slot. The connection grants the whole
 * `websocket/*` request namespace; sending and broadcasting are methods on the
 * returned handle.
 */
export const Server = (
  slot: string,
  options: ServerOptions = {},
): Effect.Effect<WebSocketServer, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<ServerIntegration>({
      integration: SERVER_INTEGRATION,
      slot,
      location: "local",
      requests: ["websocket/*"],
    });
    const host = yield* Ballast.RequestHost;

    yield* Ballast.Request<Record<string, never>, Record<string, never>>({
      integration: SERVER_INTEGRATION,
      slot,
      request: "websocket/listen",
      scopes: [listenScope(options)],
      inputSchema: AckSchema,
      outputSchema: AckSchema,
    });

    return {
      ...connection,
      port: options.port,
      path: options.path,
      ...sendServer(host, connection),
    };
  });

/** A frame received by a client slot. */
export const Message = Ballast.Topic<WebSocketMessage, ClientIntegration>({
  integration: CLIENT_INTEGRATION,
  topic: "websocket/message",
  schema: MessageSchema,
});

/** The client slot connected (emitted again after every reconnect). */
export const Open = Ballast.Topic<WebSocketOpen, ClientIntegration>({
  integration: CLIENT_INTEGRATION,
  topic: "websocket/open",
  schema: OpenSchema,
});

/** The client slot disconnected. */
export const Close = Ballast.Topic<WebSocketClose, ClientIntegration>({
  integration: CLIENT_INTEGRATION,
  topic: "websocket/close",
  schema: CloseSchema,
});

/** A frame received from one server client. */
export const ServerMessage = Ballast.Topic<WebSocketServerMessage, ServerIntegration>({
  integration: SERVER_INTEGRATION,
  topic: "websocket/server/message",
  schema: ServerMessageSchema,
});

/** A local server accepted a client. */
export const ClientConnected = Ballast.Topic<WebSocketClientInfo, ServerIntegration>({
  integration: SERVER_INTEGRATION,
  topic: "websocket/server/client.connected",
  schema: ClientInfoSchema,
});

/** A local server lost a client. */
export const ClientDisconnected = Ballast.Topic<WebSocketClientDisconnected, ServerIntegration>({
  integration: SERVER_INTEGRATION,
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
  const base = Ballast.Topic<WebSocketMessage, ClientIntegration>({
    integration: CLIENT_INTEGRATION,
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
        { ...connection, integration: CLIENT_INTEGRATION, location: "local" },
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
