import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { INTEGRATION } from "./constants.ts";
import type { Integration } from "./constants.ts";
import type { WebhookDelivery } from "./types.ts";

export { INTEGRATION } from "./constants.ts";
export { decodeBase64, encodeBase64 } from "./base64.ts";
export type * from "./types.ts";

export interface WebhookRef extends Ballast.ConnectionRef<Integration> {
  readonly hook: string;
}

export interface WebhookSubscribeOptions {
  readonly onStale?: "drop" | "deliver";
  readonly maxAgeMs?: number;
}

export interface WebhookJsonTopic<A> {
  readonly subscribe: (
    name: string,
    hook: WebhookRef,
    handler: (
      delivery: A,
    ) => Effect.Effect<void, unknown, Ballast.Runtime>,
    options?: WebhookSubscribeOptions,
  ) => Effect.Effect<void, never, Ballast.EventHost>;
}

const webhookTopic = (
  hook: string,
  options: WebhookSubscribeOptions | undefined,
): Ballast.Topic<WebhookDelivery, Integration> =>
  Ballast.Topic<WebhookDelivery, Integration>({
    integration: INTEGRATION,
    topic: "http/webhook",
    scopes: ["http:webhook:" + hook],
    onStale: options?.onStale ?? "drop",
    maxAgeMs: options?.maxAgeMs ?? 60_000,
    condition: () => ({ hook }),
  });

const subscribeWebhook = (
  name: string,
  hook: WebhookRef,
  handler: (
    delivery: WebhookDelivery,
  ) => Effect.Effect<void, unknown, Ballast.Runtime>,
  options?: WebhookSubscribeOptions,
): Effect.Effect<void, never, Ballast.EventHost> =>
  webhookTopic(hook.slot, options).subscribe(name, hook, handler);

const webhookJson = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
): WebhookJsonTopic<A> => ({
  subscribe: (name, hook, handler, options) => {
    const base = webhookTopic(hook.slot, options);
    return base.subscribe(name, hook, (delivery) =>
      Effect.gen(function* () {
        const text = new TextDecoder().decode(delivery.body);
        const parsed = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (parsed === undefined) {
          yield* Effect.logWarning("http/" + hook.slot + " webhook body was not JSON");
          return;
        }
        const decoded = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (decoded === undefined) {
          yield* Effect.logWarning("http/" + hook.slot + " webhook body did not match the schema");
          return;
        }
        yield* handler(decoded);
      }),
    );
  },
});

export interface WebhookFunction {
  (slot: string): Effect.Effect<WebhookRef>;
  readonly subscribe: (
    name: string,
    hook: WebhookRef,
    handler: (
      delivery: WebhookDelivery,
    ) => Effect.Effect<void, unknown, Ballast.Runtime>,
    options?: WebhookSubscribeOptions,
  ) => Effect.Effect<void, never, Ballast.EventHost>;
  readonly json: <A>(
    schema: Schema.Codec<A, unknown, never, never>,
  ) => WebhookJsonTopic<A>;
}

/**
 * Http.Webhook("kofi") declares a slot; Http.Webhook.subscribe("donation", hook, handler)
 * records the topic. The driver answers providers with the static response from
 * connection config; a handler cannot return a response (decision 0005).
 */
export const Webhook: WebhookFunction = Object.assign(
  (slot: string): Effect.Effect<WebhookRef> =>
    Effect.gen(function* () {
      const connection = yield* Ballast.Connection<Integration>({
        integration: INTEGRATION,
        slot,
        location: "either",
      });
      return { ...connection, hook: slot };
    }),
  {
    subscribe: subscribeWebhook,
    json: webhookJson,
  },
);
