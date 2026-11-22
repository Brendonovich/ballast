import { Schema } from "effect";

/**
 * Verification configured when a cloud hook is registered. The secret is sent
 * once over TLS, sealed in the cloud vault and never returned.
 */
export const WebhookVerification = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("shared-secret"),
    header: Schema.String,
    secret: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("hmac-sha256"),
    header: Schema.String,
    secret: Schema.String,
    encoding: Schema.Literals(["hex", "base64"]),
    prefix: Schema.optionalKey(Schema.String),
    timestampHeader: Schema.optionalKey(Schema.String),
    toleranceSeconds: Schema.optionalKey(Schema.Number),
  }),
]);
export type WebhookVerification = typeof WebhookVerification.Type;

export const WebhookStaticResponse = Schema.Struct({
  status: Schema.optionalKey(Schema.Number),
  body: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  contentType: Schema.optionalKey(Schema.String),
});
export type WebhookStaticResponse = typeof WebhookStaticResponse.Type;

export const WebhookRegistration = Schema.Struct({
  hookId: Schema.String,
  label: Schema.optionalKey(Schema.String),
  maxAgeMs: Schema.optionalKey(Schema.Number),
  onStale: Schema.optionalKey(Schema.Literals(["drop", "deliver"])),
  verification: Schema.optionalKey(WebhookVerification),
  response: Schema.optionalKey(WebhookStaticResponse),
});
export type WebhookRegistration = typeof WebhookRegistration.Type;

export const RegisterHooksRequest = Schema.Struct({
  hooks: Schema.Array(WebhookRegistration),
});
export type RegisterHooksRequest = typeof RegisterHooksRequest.Type;

export const RegisteredHook = Schema.Struct({
  hookId: Schema.String,
  url: Schema.String,
});
export type RegisteredHook = typeof RegisteredHook.Type;

export const RegisterHooksResponse = Schema.Struct({
  hooks: Schema.Array(RegisteredHook),
});
export type RegisterHooksResponse = typeof RegisterHooksResponse.Type;

export const UnregisterHooksRequest = Schema.Struct({
  hookIds: Schema.Array(Schema.String),
});
export type UnregisterHooksRequest = typeof UnregisterHooksRequest.Type;

/** A webhook request relayed to the machine, independent of any provider. */
export const WebhookRelayDelivery = Schema.Struct({
  hookId: Schema.String,
  deliveryId: Schema.String,
  method: Schema.String,
  path: Schema.String,
  query: Schema.Record(Schema.String, Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  /** Standard base64, binary safe, at most 1 MiB. */
  bodyBase64: Schema.String,
  receivedAt: Schema.Number,
});
export type WebhookRelayDelivery = typeof WebhookRelayDelivery.Type;
