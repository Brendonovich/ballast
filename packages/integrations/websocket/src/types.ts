import type { Schema } from "effect";
import type { ClientIntegration } from "./constants.ts";

export interface WebSocketMessage {
  /** Text frame contents, when the frame was text. */
  readonly text?: string;
  /** Binary frame contents, when the frame was binary. */
  readonly binary?: Uint8Array;
  readonly receivedAt: number;
}

export type WebSocketOutboundMessage =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "binary"; readonly base64: string }
  | { readonly type: "json"; readonly value: unknown };

export interface WebSocketOpen {
  readonly url: string;
  readonly connectedAt: number;
}

export interface WebSocketClose {
  readonly code: number;
  readonly reason?: string;
  readonly willReconnect: boolean;
  readonly at: number;
}

export interface WebSocketClientInfo {
  readonly clientId: string;
  readonly connectedAt: number;
}

export interface WebSocketClientDisconnected {
  readonly clientId: string;
  readonly code: number;
  readonly reason?: string;
  readonly cause: "peer" | "server" | "error";
  readonly at: number;
}

export interface WebSocketServerMessage {
  readonly clientId: string;
  readonly text?: string;
  readonly binary?: Uint8Array;
  readonly receivedAt: number;
}

export type WebSocketConnectionStatus =
  | "connecting"
  | "open"
  | "running"
  | "reconnecting"
  | "closed"
  | "error";

export interface WebSocketReconnectPolicy {
  /** Defaults to true. */
  readonly enabled?: boolean;
  /** First retry delay. Defaults to 500ms. */
  readonly initialDelayMs?: number;
  /** Retry delay cap. Defaults to 30s. */
  readonly maxDelayMs?: number;
  /** Retries before giving up. Defaults to unlimited. */
  readonly maxAttempts?: number;
}

export interface WebSocketClientConfig {
  readonly slot: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly subprotocols?: ReadonlyArray<string>;
  readonly reconnect?: WebSocketReconnectPolicy;
  readonly openTimeoutMs?: number;
  /** Defaults to 1 MiB. */
  readonly maxMessageBytes?: number;
  /** Events buffered for a slow consumer before the socket blocks. Defaults to 256. */
  readonly bufferSize?: number;
}

export type WebSocketClientEvent =
  | { readonly _tag: "open"; readonly open: WebSocketOpen }
  | { readonly _tag: "close"; readonly close: WebSocketClose }
  | { readonly _tag: "message"; readonly message: WebSocketMessage };

export interface WebSocketServerConfig {
  readonly slot: string;
  readonly host?: string;
  readonly port: number;
  /** Only accept upgrades on this path. Defaults to every path. */
  readonly path?: string;
  /** Defaults to 1 MiB. */
  readonly maxMessageBytes?: number;
  /** Defaults to 256. */
  readonly bufferSize?: number;
}

export interface WebSocketBroadcastResult {
  readonly delivered: number;
  readonly failed: number;
}

export type WebSocketServerEvent =
  | {
      readonly _tag: "client_connected";
      readonly client: WebSocketClientInfo;
    }
  | {
      readonly _tag: "client_disconnected";
      readonly client: WebSocketClientDisconnected;
    }
  | {
      readonly _tag: "message";
      readonly message: WebSocketServerMessage;
    };

export interface WebSocketJsonTopic<A> {
  readonly integration: ClientIntegration;
  readonly topic: string;
  readonly schema: Schema.Codec<A, unknown, never, never>;
  readonly subscribe: (
    name: string,
    connection: { readonly slot: string },
    handler: (
      event: A,
    ) => import("effect/Effect").Effect<
      void,
      unknown,
      import("@ballast/core").Runtime
    >,
  ) => import("effect/Effect").Effect<void, never, import("@ballast/core").EventHost>;
}
