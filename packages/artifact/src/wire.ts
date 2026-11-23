import * as Schema from "effect/Schema";
import { RequestId } from "effect/rpc/RpcMessage";
import type { FromClientEncoded, FromServerEncoded } from "effect/rpc/RpcMessage";

const Id = Schema.Union([Schema.String, Schema.Number]);

const ClientRequest = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: Id,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  isNotification: Schema.optional(Schema.Literal(true)),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean),
});

const ClientInterrupt = Schema.Struct({
  _tag: Schema.Literal("Interrupt"),
  requestId: Id,
});

const ClientPing = Schema.Struct({ _tag: Schema.Literal("Ping") });
const ClientEof = Schema.Struct({ _tag: Schema.Literal("Eof") });

const ClientMessage = Schema.Union([
  ClientRequest,
  ClientInterrupt,
  ClientPing,
  ClientEof,
]);
export type ClientMessage = Schema.Schema.Type<typeof ClientMessage>;

const Exit = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
  Schema.Struct({
    _tag: Schema.Literal("Failure"),
    cause: Schema.Array(
      Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("Fail"), error: Schema.Unknown }),
        Schema.Struct({ _tag: Schema.Literal("Die"), defect: Schema.Unknown }),
        Schema.Struct({
          _tag: Schema.Literal("Interrupt"),
          fiberId: Schema.optional(Schema.NullOr(Schema.Number)),
        }),
      ]),
    ),
  }),
]);

const ServerChunk = Schema.Struct({
  _tag: Schema.Literal("Chunk"),
  requestId: Id,
  values: Schema.NonEmptyArray(Schema.Unknown),
});

const ServerExit = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: Id,
  exit: Exit,
});

const ServerDefect = Schema.Struct({
  _tag: Schema.Literal("Defect"),
  defect: Schema.Unknown,
});

const ServerMessage = Schema.Union([ServerChunk, ServerExit, ServerDefect]);
export type ServerMessage = Schema.Schema.Type<typeof ServerMessage>;

export const decodeClientMessage = Schema.decodeUnknownSync(ClientMessage);
export const decodeServerMessage = Schema.decodeUnknownSync(ServerMessage);

export const toFromClientEncoded = (message: ClientMessage): FromClientEncoded => {
  switch (message._tag) {
    case "Request":
      return {
        _tag: "Request",
        id: message.id,
        tag: message.tag,
        payload: message.payload,
        headers: message.headers.map(([name, value]): [string, string] => [name, value]),
        ...(message.isNotification === true ? { isNotification: true } : {}),
        ...(message.traceId === undefined ? {} : { traceId: message.traceId }),
        ...(message.spanId === undefined ? {} : { spanId: message.spanId }),
        ...(message.sampled === undefined ? {} : { sampled: message.sampled }),
      };
    case "Interrupt":
      return { _tag: "Interrupt", requestId: RequestId(message.requestId) };
    case "Ping":
      return { _tag: "Ping" };
    case "Eof":
      return { _tag: "Eof" };
  }
};

export const toFromServerEncoded = (message: ServerMessage): FromServerEncoded => {
  switch (message._tag) {
    case "Chunk":
      return {
        _tag: "Chunk",
        requestId: RequestId(message.requestId),
        values: message.values,
      };
    case "Exit":
      return {
        _tag: "Exit",
        requestId: RequestId(message.requestId),
        exit:
          message.exit._tag === "Success"
            ? message.exit
            : {
                _tag: "Failure",
                cause: message.exit.cause.map((reason) =>
                  reason._tag === "Interrupt"
                    ? { _tag: "Interrupt", fiberId: reason.fiberId ?? null }
                    : reason,
                ),
              },
      };
    case "Defect":
      return { _tag: "Defect", defect: message.defect };
  }
};
