import { NodeSocketServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WebSocketDriverError } from "./errors.ts";
import { WebSocketListener } from "./server.ts";

/** Node `ws` listener adapter for the server driver. */
export const layer: Layer.Layer<WebSocketListener> = Layer.succeed(
  WebSocketListener,
  WebSocketListener.of({
    listen: (options) =>
      Effect.gen(function* () {
        const server = yield* NodeSocketServer.makeWebSocket({
          host: options.host,
          port: options.port,
          maxPayload: options.maxMessageBytes,
          ...(options.path === undefined ? {} : { path: options.path }),
        }).pipe(
          Effect.mapError(
            (error) => new WebSocketDriverError({ reason: error.message }),
          ),
        );

        const address = server.address;
        const port = "port" in address ? address.port : options.port;

        return {
          address: {
            host: options.host,
            port,
            ...(options.path === undefined ? {} : { path: options.path }),
          },
          run: (onClient) =>
            server
              .run((socket) => onClient({ socket }))
              .pipe(
                Effect.mapError(
                  (error) => new WebSocketDriverError({ reason: error.message }),
                ),
              ),
        };
      }),
  }),
);
