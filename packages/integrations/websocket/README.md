# @ballast/module-websocket

WebSocket clients and local servers for Ballast scripts. Clients and servers are
separate connection kinds: `websocket-client` is configured with a URL, and
`websocket-server` with a port. The script entry has no Node-only imports;
runtime code lives in `@ballast/module-websocket/driver`.

## Script API

```ts
import * as Ballast from "@ballast/core";
import * as WebSocket from "@ballast/module-websocket";
import { Effect, Schema } from "effect";

const ChatMessage = Schema.Struct({ user: Schema.String, text: Schema.String });

export default Effect.gen(function* () {
  const upstream = yield* WebSocket.Client("upstream");
  const bridge = yield* WebSocket.Server("bridge", { port: 1890, path: "/bridge" });

  yield* WebSocket.Json(ChatMessage).subscribe("chat", upstream, (message) =>
    bridge.broadcastText(message.user + ": " + message.text),
  );

  yield* WebSocket.ServerMessage.subscribe("server-message", bridge, (message) =>
    Effect.gen(function* () {
      if (message.text !== undefined) yield* upstream.text(message.text);
    }),
  );
});
```

Client topics: `WebSocket.Message`, `WebSocket.Open`, `WebSocket.Close`, and
`WebSocket.Json(schema)` (same bus topic, decoded per handler). Server topics:
`WebSocket.ServerMessage`, `WebSocket.ClientConnected`,
`WebSocket.ClientDisconnected`.

## Manifest capabilities

- `WebSocket.Client(slot, { url? })` records the `websocket-client` connection,
  `websocket/*` plus `websocket/connect` with `ws:connect:<host>` or
  `ws:connect:*` when the URL comes from config. Sending is `client.send` /
  `client.text` / `client.binary` / `client.json`.
- `WebSocket.Server(slot, { port?, path? })` records the `websocket-server`
  connection, `websocket/*` plus `websocket/listen` with
  `ws:listen:127.0.0.1:<port><path>`. Sending is `server.send(clientId, message)`;
  broadcasting is `server.broadcast` plus the `broadcastText` /
  `broadcastBinary` / `broadcastJson` helpers.

Connection settings are just the client URL or the server port. The script's
server path is part of the listen capability, so the agent binds the path from
the manifest and binds `127.0.0.1` by default.

## Driver

```ts
import { WebSocketClientDriver, layerNode } from "@ballast/module-websocket/driver";

const client = yield* WebSocketClientDriver;
const connection = yield* client.connect({
  slot: "upstream",
  url: "wss://example.com/socket",
});

yield* connection.events.pipe(Stream.runForEach(console.log));
yield* connection.send({ type: "text", text: "hello" });
```

Both drivers are provided by `layerNode`.

`WebSocketClientDriver` emits `open` / `message` / `close` events and reconnects
with exponential backoff. `WebSocketServerDriver` accepts clients (Node `ws`
adapter in `nodeListenerLayer`), emits connect/disconnect/message events, and
offers `sendToClient` and `broadcast`. Both services are standalone and do not
import the agent.
