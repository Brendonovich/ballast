import { createHash, randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

const AuthenticationSchema = Schema.Struct({
  challenge: Schema.String,
  salt: Schema.String,
});

const HelloPacketSchema = Schema.Struct({
  op: Schema.Literal(0),
  d: Schema.Struct({
    obsWebSocketVersion: Schema.String,
    rpcVersion: Schema.Number,
    authentication: Schema.optional(AuthenticationSchema),
  }),
});

const IdentifiedPacketSchema = Schema.Struct({
  op: Schema.Literal(2),
  d: Schema.Struct({ negotiatedRpcVersion: Schema.Number }),
});

const EventPacketSchema = Schema.Struct({
  op: Schema.Literal(5),
  d: Schema.Struct({
    eventType: Schema.String,
    eventIntent: Schema.Number,
    eventData: Schema.Unknown,
  }),
});

const RequestResponsePacketSchema = Schema.Struct({
  op: Schema.Literal(7),
  d: Schema.Struct({
    requestType: Schema.String,
    requestId: Schema.String,
    requestStatus: Schema.Struct({
      result: Schema.Boolean,
      code: Schema.Number,
      comment: Schema.optional(Schema.String),
    }),
    responseData: Schema.optional(Schema.Unknown),
  }),
});

const IncomingPacketSchema = Schema.Union([
  HelloPacketSchema,
  IdentifiedPacketSchema,
  EventPacketSchema,
  RequestResponsePacketSchema,
]);

type IncomingPacket = Schema.Schema.Type<typeof IncomingPacketSchema>;

export interface ObsEventPacket {
  readonly eventType: string;
  readonly eventIntent: number;
  readonly eventData: unknown;
}

export interface ObsSocketClient {
  readonly request: (
    requestType: string,
    requestData?: unknown,
  ) => Effect.Effect<unknown, Error>;
  readonly events: Queue.Queue<ObsEventPacket>;
  /** Completes when the underlying socket closes, for any reason. */
  readonly closed: Effect.Effect<void>;
}

const decodePacket = (text: string): IncomingPacket =>
  Schema.decodeUnknownSync(Schema.fromJsonString(IncomingPacketSchema))(text);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const authenticate = (password: string, authentication: Schema.Schema.Type<typeof AuthenticationSchema>): string => {
  const secret = createHash("sha256")
    .update(password + authentication.salt)
    .digest("base64");
  return createHash("sha256")
    .update(secret + authentication.challenge)
    .digest("base64");
};

interface PendingRequest {
  readonly requestType: string;
  readonly deferred: Deferred.Deferred<unknown, Error>;
}

/**
 * Open one obs-websocket v5 connection and complete the Hello/Identify
 * handshake. The returned client lives for the surrounding scope; `closed`
 * completes when the socket goes away so callers can reconnect.
 */
export const connectObsSocket = (
  url: string,
  password: string | undefined,
  eventSubscriptions: number,
): Effect.Effect<ObsSocketClient, Error, Socket.WebSocketConstructor | import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url);
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;

    const ready = yield* Deferred.make<void, Error>();
    const closed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<ObsEventPacket>();
    const pending = new Map<string, PendingRequest>();
    const requestPrefix = randomUUID();
    let requestSequence = 0;
    let helloReceived = false;

    const send = (packet: unknown): Effect.Effect<void, Error> =>
      writer.write(JSON.stringify(packet)).pipe(
        Effect.mapError((error) => new Error("OBS WebSocket write failed: " + error.message)),
      );

    const failPending = (error: Error): void => {
      for (const request of pending.values()) {
        Deferred.doneUnsafe(request.deferred, Exit.fail(error));
      }
      pending.clear();
    };

    const handlePacket = (packet: IncomingPacket): Effect.Effect<void, Error> => {
      switch (packet.op) {
        case 0: {
          if (helloReceived) {
            return Effect.fail(new Error("OBS sent Hello more than once"));
          }
          helloReceived = true;
          if (packet.d.rpcVersion < 1) {
            return Effect.fail(new Error("OBS does not support RPC version 1"));
          }

          const authentication = packet.d.authentication;
          if (authentication !== undefined && password === undefined) {
            return Effect.fail(
              new Error("OBS requires a password, but none was provided (use --connection-secret or BALLAST_OBS_<SLOT>_PASSWORD)"),
            );
          }

          return send({
            op: 1,
            d: {
              rpcVersion: 1,
              eventSubscriptions,
              ...(authentication === undefined || password === undefined
                ? {}
                : { authentication: authenticate(password, authentication) }),
            },
          });
        }
        case 2:
          if (packet.d.negotiatedRpcVersion !== 1) {
            return Effect.fail(new Error("OBS negotiated an unsupported RPC version"));
          }
          return Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
        case 5:
          Queue.offerUnsafe(events, packet.d);
          return Effect.void;
        case 7: {
          const request = pending.get(packet.d.requestId);
          if (request === undefined) return Effect.void;
          pending.delete(packet.d.requestId);
          const status = packet.d.requestStatus;
          if (status.result) {
            Deferred.doneUnsafe(request.deferred, Exit.succeed(packet.d.responseData ?? {}));
          } else {
            const comment = status.comment === undefined ? "" : ": " + status.comment;
            Deferred.doneUnsafe(
              request.deferred,
              Exit.fail(
                new Error(
                  "OBS request " + request.requestType + " failed (" + status.code + ")" + comment,
                ),
              ),
            );
          }
          return Effect.void;
        }
      }
    };

    const readLoop = Effect.gen(function* () {
      while (true) {
        const frames = yield* reader.pull;
        for (const frame of frames) {
          const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
          const packet = yield* Effect.try({
            try: () => decodePacket(text),
            catch: (cause) => new Error("Invalid OBS WebSocket message: " + errorMessage(cause)),
          });
          yield* handlePacket(packet);
        }
      }
    });

    yield* Effect.forkScoped(
      readLoop.pipe(
        Effect.onExit((exit) => {
          const error = Exit.isFailure(exit)
            ? new Error("OBS WebSocket connection closed: " + errorMessage(Cause.squash(exit.cause)))
            : new Error("OBS WebSocket connection closed");
          return Effect.sync(() => {
            failPending(error);
            Deferred.doneUnsafe(ready, Exit.fail(error));
            Deferred.doneUnsafe(closed, Exit.void);
          });
        }),
      ),
    );

    yield* Deferred.await(ready);

    const request = (
      requestType: string,
      requestData?: unknown,
    ): Effect.Effect<unknown, Error> =>
      Effect.gen(function* () {
        const requestId = requestPrefix + "-" + requestSequence++;
        const deferred = yield* Deferred.make<unknown, Error>();
        pending.set(requestId, { requestType, deferred });
        const packet = {
          op: 6,
          d: {
            requestType,
            requestId,
            ...(requestData === undefined ? {} : { requestData }),
          },
        };

        return yield* send(packet).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption("10 seconds"),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("OBS request " + requestType + " timed out")),
              onSome: Effect.succeed,
            }),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        );
      });

    return {
      request,
      events,
      closed: Deferred.await(closed),
    };
  });
