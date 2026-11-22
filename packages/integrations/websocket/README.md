# @ballast/module-websocket

WebSocket clients and local servers for Ballast scripts. The script entry has no
Node-only imports; runtime code lives in `@ballast/module-websocket/driver`.

## Script API

```ts
import * as Ballast from "@ballast/core";
import * as WebSocket from "@ballast/module-websocket";
import { Effect, Schema } from "effect";

const ChatMessage = Schema.Struct({ user: Schema.String, text: Schema.String });

export default Effect.gen(function* () {
  const upstream = yield* WebSocket.Client("upstream");
  const bridge = yield* WebSocket.Server("bridge", { port: 1890, path: "/bridge" });

  const send = yield* WebSocket.Send(upstream);
  const out = yield* WebSocket.ServerSend(bridge);

  yield* WebSocket.Json(ChatMessage).subscribe(upstream, (message) =>
    out.broadcastText(message.user + ": " + message.text),
  );

  yield* WebSocket.ServerMessage.subscribe(bridge, (message) =>
    Effect.gen(function* () {
      if (message.text !== undefined) yield* send.text(message.text);
    }),
  );
});
```

Client topics: `WebSocket.Message`, `WebSocket.Open`, `WebSocket.Close`, and
`WebSocket.Json(schema)` (same bus topic, decoded per handler). Server topics:
`WebSocket.ServerMessage`, `WebSocket.ClientConnected`,
`WebSocket.ClientDisconnected`.

## Manifest capabilities

- `WebSocket.Client(slot, { url? })` records `websocket/connect` with
  `ws:connect:<host>` or `ws:connect:*` when the URL comes from config.
- `WebSocket.Server(slot, { host?, port?, path? })` records `websocket/listen`
  with `ws:listen:<host>:<port><path>`.
- `WebSocket.Send` records `websocket/send`; `WebSocket.ServerSend` records
  `websocket/sendToClient` and `websocket/broadcast`.

Connection config (agent-side) supplies the URL, headers, subprotocols, reconnect
policy, and the server host/port/path. The optional script values are intent and
manifest hints, not secrets.

## Driver

```ts
import { layerNode } from "@ballast/module-websocket/driver";

const client = yield* WebSocketClientDriver;
const connection = yield* client.connect({
  slot: "upstream",
  url: "wss://example.com/socket",
  headers: { authorization: "Bearer …" },
  subprotocols: ["chat"],
  reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
});

yield* connection.events.pipe(Stream.runForEach(console.log));
yield* connection.send({ type: "text", text: "hello" });
```

`WebSocketClientDriver` emits `open` / `message` / `close` events and reconnects
with exponential backoff. `WebSocketServerDriver` accepts clients (Node `ws`
adapter in `nodeListenerLayer`), emits connect/disconnect/message events, and
offers `sendToClient` and `broadcast`. Both services are standalone and do not
import the agent.
