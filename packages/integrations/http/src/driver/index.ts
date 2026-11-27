import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { layer as relayLayer } from "./relay.ts";
import type { WebhookRelayOptions } from "./relay.ts";
import { layer as webhookDriverLayer } from "./webhook.ts";

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

/** Webhook driver has no ambient dependencies; local listeners use Node HTTP. */
export const webhookLayer = webhookDriverLayer;

/** Cloud webhook relay wired to fetch and ws. */
export const relayLayerNode = (options: WebhookRelayOptions) =>
  relayLayer(options).pipe(
    Layer.provide(fetchLayer),
    Layer.provide(NodeWS.layerWebSocketConstructor),
  );
