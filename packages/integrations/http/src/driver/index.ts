import { NodeSocket } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { layer as httpClientLayer } from "./client.ts";
import { layer as relayLayer } from "./relay.ts";
import type { WebhookRelayOptions } from "./relay.ts";
import { layer as webhookDriverLayer } from "./webhook.ts";

export { HttpClientDriver, layer as httpClientLayer } from "./client.ts";
export type { HttpClientDriverRequest } from "./client.ts";
export { HttpDriverError } from "./errors.ts";
export {
  WebhookRelay,
  decodeWebhookRelayFrame,
  layer as webhookRelayLayer,
  layerNode as webhookRelayLayerNode,
} from "./relay.ts";
export type {
  RegisteredWebhook,
  WebhookRegistration,
  WebhookRelayDelivery,
  WebhookRelayFrame,
  WebhookRelayOptions,
} from "./relay.ts";
export { WebhookDriver } from "./webhook.ts";
export type { WebhookRuntime } from "./webhook.ts";

const fetchLayer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      redirect: "manual",
      credentials: "omit",
    }),
  ),
);

/** HTTP client driver wired to fetch. Redirects are followed by the driver. */
export const layerNode = httpClientLayer.pipe(Layer.provide(fetchLayer));

/** Webhook driver has no ambient dependencies; local listeners use Node HTTP. */
export const webhookLayer = webhookDriverLayer;

/** Cloud webhook relay wired to fetch and ws. */
export const relayLayerNode = (options: WebhookRelayOptions) =>
  relayLayer(options).pipe(
    Layer.provide(fetchLayer),
    Layer.provide(NodeSocket.layerWebSocketConstructorWS),
  );
