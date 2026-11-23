import type { MessagePort } from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { Rpc } from "effect/rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { FromClientEncoded, FromServerEncoded } from "effect/rpc/RpcMessage";
import type { Scope } from "effect/Scope";
import * as RpcServer from "effect/rpc/RpcServer";
import type { RpcClientError } from "effect/rpc/RpcClientError";

export const SettingValueSchema = Schema.NullOr(
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Array(Schema.String),
  ]),
);
export type SettingValue = Schema.Schema.Type<typeof SettingValueSchema>;

/**
 * Host <-> script RPC. The worker is the client; the agent main thread is the
 * server. No RPC is used for event delivery: the host pushes decoded events on
 * the worker's `parentPort` after `RegisterTopic`.
 */
export const RuntimeRpcs = RpcGroup.make(
  Rpc.make("Ready", {
    payload: { generation: Schema.Number },
    success: Schema.Void,
  }),
  Rpc.make("RegisterTopic", {
    payload: { key: Schema.String },
    success: Schema.Void,
  }),
  Rpc.make("GetSetting", {
    payload: { key: Schema.String },
    success: SettingValueSchema,
  }),
  Rpc.make("Request", {
    payload: {
      integration: Schema.String,
      request: Schema.String,
      slot: Schema.String,
      input: Schema.Unknown,
    },
    success: Schema.Unknown,
    error: Schema.String,
  }),
  Rpc.make("RegisterTimer", {
    payload: { name: Schema.String },
    success: Schema.Void,
  }),
  Rpc.make("ScheduleTimer", {
    payload: {
      name: Schema.String,
      key: Schema.String,
      delayMs: Schema.Number,
      payload: Schema.Json,
      payloadFingerprint: Schema.String,
      onStale: Schema.Literals(["drop", "deliver"]),
      maxAgeMs: Schema.Number,
    },
    success: Schema.Void,
    error: Schema.String,
  }),
  Rpc.make("CancelTimer", {
    payload: { name: Schema.String, key: Schema.String },
    success: Schema.Void,
  }),
);

export interface RuntimeHostHandlers {
  readonly ready: (payload: { readonly generation: number }) => Effect.Effect<void>;
  readonly registerTopic: (payload: { readonly key: string }) => Effect.Effect<void>;
  readonly getSetting: (payload: { readonly key: string }) => Effect.Effect<SettingValue>;
  readonly request: (payload: {
    readonly integration: string;
    readonly request: string;
    readonly slot: string;
    readonly input: unknown;
  }) => Effect.Effect<unknown, string>;
  /**
   * Optional so existing hosts keep compiling. A host that does not implement
   * timers fails loudly when a script uses one.
   */
  readonly registerTimer?: (payload: { readonly name: string }) => Effect.Effect<void>;
  readonly scheduleTimer?: (payload: {
    readonly name: string;
    readonly key: string;
    readonly delayMs: number;
    readonly payload: Schema.Json;
    readonly payloadFingerprint: string;
    readonly onStale: "drop" | "deliver";
    readonly maxAgeMs: number;
  }) => Effect.Effect<void, string>;
  readonly cancelTimer?: (payload: {
    readonly name: string;
    readonly key: string;
  }) => Effect.Effect<void>;
}

const codecFor = Schema.toCodecJson;

const makeServerProtocol = (
  port: MessagePort,
): Effect.Effect<
  Omit<RpcServer.Protocol["Service"], "run">,
  never,
  Scope
> =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const services = yield* Effect.context<never>();
      const disconnects = yield* Queue.unbounded<number>();
      let disconnected = false;

      const disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        Queue.offerUnsafe(disconnects, 0);
      };

      const onMessage = (message: FromClientEncoded) => {
        Effect.runForkWith(services)(
          writeRequest(0, message).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Runtime RPC request failed", cause),
            ),
          ),
        );
      };

      const onMessageError = (cause: unknown) => {
        Effect.runFork(Effect.logError("Runtime RPC port error", cause));
        disconnect();
      };

      port.on("message", onMessage);
      port.on("messageerror", onMessageError);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          port.off("message", onMessage);
          port.off("messageerror", onMessageError);
          disconnect();
          port.close();
        }),
      );

      return {
        disconnects,
        send: (_clientId, response: FromServerEncoded) =>
          Effect.sync(() => {
            port.postMessage(response);
          }),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: false,
        supportsTransferables: true,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor,
      };
    }),
  );

const makeClientProtocol = (
  port: MessagePort,
): Effect.Effect<
  Omit<RpcClient.Protocol["Service"], "run">,
  never,
  Scope
> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const services = yield* Effect.context<never>();

      const onMessage = (message: FromServerEncoded) => {
        Effect.runForkWith(services)(
          writeResponse(0, message).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Runtime RPC response failed", cause),
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
            port.postMessage(request);
          }),
        supportsAck: false,
        supportsTransferables: true,
        codecFor,
      };
    }),
  );

/**
 * Serve the runtime RPC group on the host side of a MessagePort. Runs until the
 * surrounding scope closes.
 */
export const serveRuntimeRpc = (
  port: MessagePort,
  handlers: RuntimeHostHandlers,
): Effect.Effect<never, never, Scope> =>
  Effect.gen(function* () {
    const protocol = yield* makeServerProtocol(port);
    return yield* RpcServer.make(RuntimeRpcs).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        RuntimeRpcs.toLayer({
          Ready: handlers.ready,
          RegisterTopic: handlers.registerTopic,
          GetSetting: handlers.getSetting,
          Request: handlers.request,
          RegisterTimer:
            handlers.registerTimer ??
            (() =>
              Effect.die(
                new Error("Timer support is not implemented by this runtime host"),
              )),
          ScheduleTimer:
            handlers.scheduleTimer ??
            (() =>
              Effect.die(
                new Error("Timer support is not implemented by this runtime host"),
              )),
          CancelTimer:
            handlers.cancelTimer ??
            (() =>
              Effect.die(
                new Error("Timer support is not implemented by this runtime host"),
              )),
        }),
      ),
    );
  });

export type RuntimeRpcClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof RuntimeRpcs>,
  RpcClientError
>;

/** Create the worker-side RPC client. The client lives for the surrounding scope. */
export const makeRuntimeRpcClient = (
  port: MessagePort,
): Effect.Effect<RuntimeRpcClient, never, Scope> =>
  Effect.gen(function* () {
    const protocol = yield* makeClientProtocol(port);
    return yield* RpcClient.make(RuntimeRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  });
