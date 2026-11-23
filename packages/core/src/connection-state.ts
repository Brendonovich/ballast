import * as Schema from "effect/Schema";
import { Topic } from "./topic.ts";

/**
 * Shared connection lifecycle payload. Integrations that can disconnect and
 * reconnect expose a topic built with `ConnectionState.topic(INTEGRATION)`.
 * History is off by default because these are live lifecycle signals, not a
 * replayable log.
 */
export const ConnectionStatePayloadSchema = Schema.Struct({
  state: Schema.Literals(["connected", "disconnected"]),
  reconnected: Schema.Boolean,
  at: Schema.Number,
});
export type ConnectionStatePayload = Schema.Schema.Type<
  typeof ConnectionStatePayloadSchema
>;

export const topic = <Integration extends string>(integration: Integration) =>
  Topic<ConnectionStatePayload, Integration>({
    integration,
    topic: integration + "/ConnectionState",
    schema: ConnectionStatePayloadSchema,
    history: false,
  });
