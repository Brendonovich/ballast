import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { API_NAME, API_VERSION } from "../constants.ts";
import { APIErrorDataSchema, AUTH_INVALID_ERROR_IDS, errorName } from "../protocol.ts";
import {
  VTubeStudioAuthenticationError,
  VTubeStudioConnectionError,
  VTubeStudioProtocolError,
  VTubeStudioRequestError,
  errorMessage,
} from "./errors.ts";

const PacketSchema = Schema.Struct({
  apiName: Schema.optional(Schema.String),
  apiVersion: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  requestID: Schema.optional(Schema.String),
  messageType: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

type Packet = Schema.Schema.Type<typeof PacketSchema>;

export interface VTubeStudioEventPacket {
  readonly messageType: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface VTubeStudioCallOptions {
  /** Overrides the session's request timeout (used for plugin approval). */
  readonly timeout?: Duration.Input;
  /**
   * When VTube Studio answers with an auth-revoked error, fail
   * `authInvalid` so the driver reconnects and requests a new token.
   * Defaults to true; the driver turns it off for authentication requests.
   */
  readonly invalidateOnAuthError?: boolean;
}

export interface VTubeStudioSession {
  readonly call: (
    requestType: string,
    data: unknown,
    options?: VTubeStudioCallOptions,
  ) => Effect.Effect<unknown, VTubeStudioConnectionError | VTubeStudioRequestError>;
  /** Succeeds when the underlying socket closes, for any reason. */
  readonly closed: Effect.Effect<void>;
  /** Fails when the plugin's token was revoked; reconnect to re-request. */
  readonly authInvalid: Effect.Effect<never, VTubeStudioAuthenticationError>;
}

export interface VTubeStudioSessionOptions {
  readonly url: string;
  readonly requestTimeout: Duration.Input;
  readonly onEvent: (packet: VTubeStudioEventPacket) => void;
}

interface PendingRequest {
  readonly requestType: string;
  readonly invalidateOnAuthError: boolean;
  readonly deferred: Deferred.Deferred<
    unknown,
    VTubeStudioConnectionError | VTubeStudioRequestError
  >;
}

const authInvalidError = (code: number, message: string): VTubeStudioAuthenticationError =>
  new VTubeStudioAuthenticationError({
    message:
      "VTube Studio revoked this plugin's access (" + errorName(code) + "): " + message,
    code,
    invalidatedToken: true,
  });

/**
 * One VTube Studio WebSocket session: request/response correlation by
 * `requestID`, APIError mapping, and event delivery to the caller.
 *
 * Authentication is deliberately not here; the driver owns the token flow so
 * a revoked token can be re-requested without reconnecting twice.
 */
export const connectSession = (
  options: VTubeStudioSessionOptions,
): Effect.Effect<
  VTubeStudioSession,
  VTubeStudioConnectionError,
  Socket.WebSocketConstructor | Scope.Scope
> =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(options.url);
    const writer = yield* socket.writer;
    const reader = yield* socket.reader.pipe(
      Effect.mapError(
        (error) =>
          new VTubeStudioConnectionError({
            message: "Could not connect to " + options.url + ": " + errorMessage(error),
          }),
      ),
    );

    const closed = yield* Deferred.make<void>();
    const authInvalid = yield* Deferred.make<never, VTubeStudioAuthenticationError>();
    const pending = new Map<string, PendingRequest>();
    let sequence = 0;

    const connectionError = (message: string) =>
      new VTubeStudioConnectionError({ message });

    const failPending = (error: VTubeStudioConnectionError): Effect.Effect<void> =>
      Effect.gen(function* () {
        const requests = [...pending.values()];
        pending.clear();
        yield* Effect.forEach(
          requests,
          (request) => Deferred.fail(request.deferred, error),
          { discard: true },
        );
      });

    const handlePacket = (packet: Packet): Effect.Effect<void> => {
      if (packet.messageType === "APIError") {
        const request = packet.requestID === undefined ? undefined : pending.get(packet.requestID);
        if (request === undefined) {
          return Effect.logWarning("VTube Studio API error without a pending request");
        }
        pending.delete(packet.requestID ?? "");
        const decoded = Schema.decodeUnknownOption(APIErrorDataSchema)(packet.data ?? {});
        const info = Option.getOrUndefined(decoded);
        const code = info?.errorID;
        const message = info?.message ?? "VTube Studio rejected the request";
        const label = code === undefined ? "" : " (" + errorName(code) + ")";
        const error = new VTubeStudioRequestError({
          requestType: request.requestType,
          message: request.requestType + " failed" + label + ": " + message,
          ...(code === undefined ? {} : { code }),
        });
        return Effect.gen(function* () {
          yield* Deferred.fail(request.deferred, error);
          if (
            request.invalidateOnAuthError &&
            code !== undefined &&
            AUTH_INVALID_ERROR_IDS.has(code)
          ) {
            yield* Deferred.fail(authInvalid, authInvalidError(code, message));
          }
        });
      }

      const request = packet.requestID === undefined ? undefined : pending.get(packet.requestID);
      if (request !== undefined) {
        pending.delete(packet.requestID ?? "");
        const expected = request.requestType + "Response";
        if (packet.messageType !== expected) {
          const error = new VTubeStudioRequestError({
            requestType: request.requestType,
            message:
              "Expected " + expected + " but VTube Studio sent " + packet.messageType,
          });
          return Deferred.fail(request.deferred, error).pipe(Effect.asVoid);
        }
        return Deferred.succeed(request.deferred, packet.data ?? {}).pipe(Effect.asVoid);
      }

      options.onEvent({ messageType: packet.messageType, data: packet.data ?? {} });
      return Effect.void;
    };

    const readLoop = Effect.gen(function* () {
      while (true) {
        const frames = yield* reader.pull;
        for (const frame of frames) {
          const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
          const packet = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(PacketSchema),
          )(text).pipe(
            Effect.mapError(
              (cause) =>
                new VTubeStudioProtocolError({
                  message: "Invalid VTube Studio message: " + errorMessage(cause),
                }),
            ),
          );
          yield* handlePacket(packet);
        }
      }
    });

    yield* Effect.forkScoped(
      readLoop.pipe(
        Effect.onExit((exit) => {
          const failed = Exit.isFailure(exit);
          const reason = failed
            ? errorMessage(Cause.squash(exit.cause))
            : "connection closed";
          return Effect.gen(function* () {
            if (failed && !Cause.hasInterruptsOnly(exit.cause)) {
              yield* Effect.logWarning("VTube Studio socket closed: " + reason);
            }
            yield* failPending(connectionError("VTube Studio connection lost: " + reason));
            yield* Deferred.succeed(closed, undefined);
          });
        }),
      ),
    );

    const closedFailure: Effect.Effect<never, VTubeStudioConnectionError> =
      Deferred.await(closed).pipe(
        Effect.andThen(
          Effect.fail(connectionError("VTube Studio connection closed")),
        ),
      );

    const call = (
      requestType: string,
      data: unknown,
      callOptions?: VTubeStudioCallOptions,
    ): Effect.Effect<unknown, VTubeStudioConnectionError | VTubeStudioRequestError> =>
      Effect.gen(function* () {
        const requestID = "ballast-" + sequence++;
        const deferred = yield* Deferred.make<
          unknown,
          VTubeStudioConnectionError | VTubeStudioRequestError
        >();
        pending.set(requestID, {
          requestType,
          invalidateOnAuthError: callOptions?.invalidateOnAuthError ?? true,
          deferred,
        });

        const packet = {
          apiName: API_NAME,
          apiVersion: API_VERSION,
          requestID,
          messageType: requestType + "Request",
          data: data ?? {},
        };

        return yield* writer.write(JSON.stringify(packet)).pipe(
          Effect.mapError((error) =>
            connectionError("VTube Studio write failed: " + errorMessage(error)),
          ),
          Effect.andThen(Deferred.await(deferred)),
          Effect.raceFirst(closedFailure),
          Effect.timeoutOption(callOptions?.timeout ?? options.requestTimeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new VTubeStudioRequestError({
                    requestType,
                    message: "VTube Studio " + requestType + " timed out",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(requestID))),
        );
      });

    return {
      call,
      closed: Deferred.await(closed),
      authInvalid: Deferred.await(authInvalid),
    };
  });
