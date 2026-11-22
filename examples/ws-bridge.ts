import * as WebSocket from "@ballast/module-websocket";
import { Effect, Schema } from "effect";

const ChatMessage = Schema.Struct({
  user: Schema.String,
  text: Schema.String,
});

export default Effect.gen(function* () {
  const upstream = yield* WebSocket.Client("upstream");
  const bridge = yield* WebSocket.Server("bridge", { port: 1890, path: "/bridge" });
  const send = yield* WebSocket.Send(upstream);
  const out = yield* WebSocket.ServerSend(bridge);

  yield* WebSocket.Json(ChatMessage).subscribe(upstream, (message) =>
    Effect.gen(function* () {
      yield* out.broadcastText(message.user + ": " + message.text);
    }),
  );

  yield* WebSocket.ServerMessage.subscribe(bridge, (message) =>
    Effect.gen(function* () {
      if (message.text !== undefined) {
        yield* send.text(message.text);
      }
    }),
  );
});
