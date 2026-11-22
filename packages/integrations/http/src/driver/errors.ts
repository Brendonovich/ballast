import * as Schema from "effect/Schema";

export class HttpDriverError extends Schema.TaggedError<HttpDriverError>()("HttpDriverError", {
  reason: Schema.String,
  status: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
}) {}
