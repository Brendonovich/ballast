import * as Data from "effect/Data";
import { Schema } from "effect";

const fields = {
  integration: Schema.String,
  slot: Schema.String,
  connectionId: Schema.optionalKey(Schema.String),
  message: Schema.String,
};

/** The connection exists but is not usable right now. */
export class ConnectionUnavailable extends Data.TaggedError("ConnectionUnavailable")<{
  readonly integration: string;
  readonly slot: string;
  readonly connectionId?: string;
  readonly message: string;
}> {}

export const ConnectionUnavailableSchema = Schema.TaggedStruct(
  "ConnectionUnavailable",
  fields,
);

/** The connection was reached, but the request itself failed. */
export class ConnectionRequestFailed extends Data.TaggedError("ConnectionRequestFailed")<{
  readonly integration: string;
  readonly slot: string;
  readonly connectionId?: string;
  readonly message: string;
}> {}

export const ConnectionRequestFailedSchema = Schema.TaggedStruct(
  "ConnectionRequestFailed",
  fields,
);

export const ConnectionRequestErrorSchema = Schema.Union([
  ConnectionUnavailableSchema,
  ConnectionRequestFailedSchema,
]);
export type ConnectionRequestErrorWire = Schema.Schema.Type<
  typeof ConnectionRequestErrorSchema
>;
export type ConnectionRequestError = ConnectionUnavailable | ConnectionRequestFailed;

export const connectionRequestErrorFromWire = (
  wire: ConnectionRequestErrorWire,
): ConnectionRequestError =>
  wire._tag === "ConnectionUnavailable"
    ? new ConnectionUnavailable({
        integration: wire.integration,
        slot: wire.slot,
        ...(wire.connectionId === undefined ? {} : { connectionId: wire.connectionId }),
        message: wire.message,
      })
    : new ConnectionRequestFailed({
        integration: wire.integration,
        slot: wire.slot,
        ...(wire.connectionId === undefined ? {} : { connectionId: wire.connectionId }),
        message: wire.message,
      });

export const connectionRequestError = (input: {
  readonly integration: string;
  readonly slot: string;
  readonly connectionId?: string;
  readonly message: string;
}): ConnectionRequestError =>
  input.message.toLowerCase().includes("not connected") ||
  input.message.toLowerCase().includes("offline") ||
  input.message.toLowerCase().includes("unavailable")
    ? new ConnectionUnavailable(input)
    : new ConnectionRequestFailed(input);
