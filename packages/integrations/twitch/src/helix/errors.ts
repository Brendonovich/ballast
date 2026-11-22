import * as Schema from "effect/Schema";

/**
 * Twitch Helix failure. `status` and `code` are present when Twitch answered;
 * `transient` marks transport errors and retryable statuses.
 */
export class HelixError extends Schema.TaggedError<HelixError>()("HelixError", {
  reason: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  transient: Schema.optional(Schema.Boolean),
  rateLimit: Schema.optional(Schema.Number),
  rateLimitRemaining: Schema.optional(Schema.Number),
  rateLimitReset: Schema.optional(Schema.Number),
}) {
  override get message() {
    return this.reason;
  }
}

export const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status < 600);
