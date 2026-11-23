import type { MessagePort } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { Schema as SchemaModule } from "effect";
import type { FromClientEncoded, FromServerEncoded } from "effect/rpc/RpcMessage";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcServer from "effect/rpc/RpcServer";
import type { Scope } from "effect/Scope";
import { runtimeLayer, Runtime } from "./runtime.ts";
import type { ManifestRecorder } from "./services.ts";
import type { ScriptHostServices } from "./script.ts";

const ARTIFACT_KIND = "artifact";

/** Host -> worker frame on the dedicated artifact MessagePort. */
export interface ArtifactHostMessage {
  readonly kind: typeof ARTIFACT_KIND;
  readonly frame: FromClientEncoded;
}

/** Worker -> host frame on the dedicated artifact MessagePort. */
export interface ArtifactWorkerMessage {
  readonly kind: typeof ARTIFACT_KIND;
  readonly frame: FromServerEncoded;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isFromClientEncoded = (value: unknown): value is FromClientEncoded => {
  if (!isObject(value) || typeof value["_tag"] !== "string") return false;
  switch (value["_tag"]) {
    case "Request":
    case "Ack":
    case "Interrupt":
    case "Ping":
    case "Eof":
      return true;
    default:
      return false;
  }
};

const isFromServerEncoded = (value: unknown): value is FromServerEncoded => {
  if (!isObject(value) || typeof value["_tag"] !== "string") return false;
  switch (value["_tag"]) {
    case "Chunk":
    case "Exit":
    case "Defect":
    case "ClientEnd":
    case "Pong":
      return true;
    default:
      return false;
  }
};

export const isArtifactHostMessage = (value: unknown): value is ArtifactHostMessage =>
  isObject(value) &&
  value["kind"] === ARTIFACT_KIND &&
  isFromClientEncoded(value["frame"]);

export const isArtifactWorkerMessage = (value: unknown): value is ArtifactWorkerMessage =>
  isObject(value) &&
  value["kind"] === ARTIFACT_KIND &&
  isFromServerEncoded(value["frame"]);

const makeServerProtocol = (
  port: MessagePort,
): Effect.Effect<Omit<RpcServer.Protocol["Service"], "run">, never, Scope> =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const services = yield* Effect.context<never>();
      const disconnects = yield* Queue.unbounded<number>();

      const onMessage = (message: unknown) => {
        if (!isArtifactHostMessage(message)) return;
        Effect.runForkWith(services)(
          writeRequest(0, message.frame).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Artifact RPC request failed", cause),
            ),
          ),
        );
      };

      port.on("message", onMessage);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          port.off("message", onMessage);
          port.close();
        }),
      );

      return {
        disconnects,
        send: (_clientId, response: FromServerEncoded) =>
          Effect.sync(() => {
            port.postMessage({ kind: ARTIFACT_KIND, frame: response } satisfies ArtifactWorkerMessage);
          }),
        end: () => Effect.sync(() => port.close()),
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: false,
        supportsTransferables: true,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor: SchemaModule.toCodecJson,
      };
    }),
  );

/**
 * Worker-side artifact API server. The host uses an `RpcClient` for the same
 * group over the other end of the MessagePort; encoded Effect RPC frames and
 * streams cross directly, and cancellation is an `Interrupt` frame.
 */
export const serveArtifactRpc = <
  Rpcs extends Rpc.Any,
  Handlers extends RpcGroup.HandlersFrom<Rpcs>,
>(
  port: MessagePort,
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Handlers,
  services: Context.Context<
    | Exclude<ScriptHostServices, ManifestRecorder>
    | Exclude<RpcGroup.HandlersServices<Rpcs, Handlers>, Runtime>
    | Rpc.ServicesServer<Rpcs>
  >,
): Effect.Effect<never, never, Scope> =>
  Effect.gen(function* () {
    const protocol = yield* makeServerProtocol(port);
    const handlerLayer = group.toLayer(handlers).pipe(Layer.provide(runtimeLayer));
    return yield* RpcServer.make(group).pipe(
      Effect.provide(handlerLayer),
      Effect.provideContext(services),
      Effect.provideService(RpcServer.Protocol, protocol),
    );
  });

const makeClientProtocol = (
  port: MessagePort,
): Effect.Effect<Omit<RpcClient.Protocol["Service"], "run">, never, Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const services = yield* Effect.context<never>();
      const onMessage = (message: unknown) => {
        if (!isArtifactWorkerMessage(message)) return;
        Effect.runForkWith(services)(
          writeResponse(0, message.frame).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Artifact RPC response failed", cause),
            ),
          ),
        );
      };
      port.on("message", onMessage);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          port.off("message", onMessage);
          port.close();
        }),
      );
      return {
        send: (_clientId, request: FromClientEncoded) =>
          Effect.sync(() => {
            port.postMessage({ kind: ARTIFACT_KIND, frame: request } satisfies ArtifactHostMessage);
          }),
        supportsAck: false,
        supportsTransferables: true,
        codecFor: SchemaModule.toCodecJson,
      };
    }),
  );

/**
 * Host-side client for a worker artifact API. Exported so the service and the
 * in-process core test use the exact same wire contract.
 */
export const makeArtifactRpcClient = <Rpcs extends Rpc.Any>(
  port: MessagePort,
  group: RpcGroup.RpcGroup<Rpcs>,
): Effect.Effect<RpcClient.RpcClient<Rpcs, RpcClientError>, never, Scope> =>
  Effect.gen(function* () {
    const protocol = yield* makeClientProtocol(port);
    return yield* RpcClient.make(group).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  });
