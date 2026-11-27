import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Layer from "effect/Layer";
import { layer as clientLayer } from "./client.ts";
import { layer as nodeListenerLayer } from "./node.ts";
import { layer as serverLayer } from "./server.ts";

export {
  WebSocketClientDriver,
  layer as clientLayer,
  layer as clientDriverLayer,
} from "./client.ts";
export type { WebSocketClientConnection } from "./client.ts";
export {
  WebSocketServerDriver,
  WebSocketListener,
  layer as serverLayer,
  layer as serverDriverLayer,
} from "./server.ts";
export type {
  WebSocketListenerClient,
  WebSocketListenerServer,
  WebSocketServerConnection,
} from "./server.ts";
export { WebSocketDriverError } from "./errors.ts";
export { layer as nodeListenerLayer } from "./node.ts";

/** Both drivers wired to Node's ws implementation. */
export const layerNode = Layer.mergeAll(
  clientLayer.pipe(Layer.provide(NodeWS.layerWebSocketConstructor)),
  serverLayer.pipe(Layer.provide(nodeListenerLayer)),
);
