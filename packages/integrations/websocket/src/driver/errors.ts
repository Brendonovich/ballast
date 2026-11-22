import * as Schema from "effect/Schema";

/** Any failure while connecting, listening, sending or receiving. */
export class WebSocketDriverError extends Schema.TaggedError<WebSocketDriverError>()(
  "WebSocketDriverError",
  {
    reason: Schema.String,
  },
) {
  constructor(props: { readonly reason: string }) {
    super(props);
  }
}
