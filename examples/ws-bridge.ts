import * as WebSocket from "@ballast/module-websocket";
import { Effect, Schema } from "effect";

const ChatMessage = Schema.Struct({
  user: Schema.String,
  text: Schema.String,
});

export default Effect.gen(function* () {
  const upstream = yield* WebSocket.Client("upstream");
  const bridge = yield* WebSocket.Server("bridge", { port: 1890, path: "/bridge" });

  yield* WebSocket.Json(ChatMessage).subscribe("chat", upstream, (message) =>
    Effect.gen(function* () {
      yield* bridge.broadcastText(message.user + ": " + message.text);
    }),
  );

  yield* WebSocket.ServerMessage.subscribe("server-message", bridge, (message) =>
    Effect.gen(function* () {
      if (message.text !== undefined) {
        yield* upstream.text(message.text);
      }
    }),
  );
});
