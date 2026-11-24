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
import type { DatabaseExecuteInput, SqlErrorWire } from "./database.ts";
import { SqlErrorWireSchema } from "./database.ts";
import { ConnectionRequestErrorSchema } from "./errors.ts";
import type { ConnectionRequestError } from "./errors.ts";
import * as RpcServer from "effect/rpc/RpcServer";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import {
  HistoryRecordSchema,
  type HistoryRecord,
} from "./history-types.ts";

export type {
  EventHistoryHostService,
  HistoryEntry,
  HistoryPolicy,
  HistoryQuery,
  HistoryRecord,
} from "./history-types.ts";

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
    error: ConnectionRequestErrorSchema,
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
  Rpc.make("StoreLoad", {
    payload: {
      name: Schema.String,
      kind: Schema.Literals(["counter"]),
      initial: Schema.optional(Schema.Number),
    },
    success: Schema.Unknown,
  }),
  Rpc.make("StoreSetCounter", {
    payload: { name: Schema.String, value: Schema.Number },
    success: Schema.Number,
  }),
  Rpc.make("StoreIncrement", {
    payload: { name: Schema.String, by: Schema.Number, initial: Schema.Number },
    success: Schema.Number,
  }),
  Rpc.make("UnitFailed", {
    payload: {
      unit: Schema.String,
      error: Schema.String,
      source: Schema.optional(
        Schema.Struct({
          file: Schema.String,
          line: Schema.Number,
          column: Schema.Number,
        }),
      ),
    },
    success: Schema.Void,
  }),
  Rpc.make("EventHistoryRecord", {
    payload: {
      name: Schema.String,
      fingerprint: Schema.String,
      event: Schema.Json,
    },
    success: HistoryRecordSchema,
  }),
  Rpc.make("EventHistoryQuery", {
    payload: {
      name: Schema.String,
      limit: Schema.Number,
      before: Schema.optional(Schema.String),
    },
    success: Schema.Array(HistoryRecordSchema),
  }),
  Rpc.make("DatabaseExecute", {
    payload: {
      name: Schema.String,
      sql: Schema.String,
      params: Schema.Array(Schema.Unknown),
      method: Schema.Literals([
        "execute",
        "executeRaw",
        "executeValues",
        "executeValuesUnprepared",
        "executeUnprepared",
      ]),
    },
    success: Schema.Unknown,
    error: SqlErrorWireSchema,
  }),
);

interface RuntimeMemoryStore {
  counter?: number;
}

/**
 * Fallback for `ballast run` and hosts that have not implemented persistent
 * stores yet. The service should provide the store handlers.
 */
const memoryStores = new Map<string, RuntimeMemoryStore>();

const memoryLoad = (input: {
  readonly name: string;
  readonly kind: "counter";
  readonly initial?: number | undefined;
}): unknown => memoryStores.get(input.name)?.counter ?? input.initial ?? 0;

const memoryHistory = new Map<string, ReadonlyArray<HistoryRecord>>();
let historyCursor = 0;

const memoryHistoryRecord = (input: {
  readonly name: string;
  readonly fingerprint: string;
  readonly event: Schema.Json;
}): HistoryRecord => {
  historyCursor += 1;
  const record: HistoryRecord = {
    cursor: String(historyCursor),
    receivedAt: Date.now(),
    fingerprint: input.fingerprint,
    event: input.event,
  };
  memoryHistory.set(input.name, [...(memoryHistory.get(input.name) ?? []), record]);
  return record;
};

const memoryHistoryQuery = (input: {
  readonly name: string;
  readonly limit: number;
  readonly before?: string | undefined;
}): ReadonlyArray<HistoryRecord> => {
  const records = memoryHistory.get(input.name) ?? [];
  const end =
    input.before === undefined
      ? records.length
      : records.findIndex((record) => record.cursor === input.before);
  const slice = records.slice(0, end === -1 ? records.length : end);
  return slice.slice(-input.limit).reverse();
};

export interface RuntimeHostHandlers {
  readonly ready: (payload: { readonly generation: number }) => Effect.Effect<void>;
  readonly registerTopic: (payload: { readonly key: string }) => Effect.Effect<void>;
  readonly getSetting: (payload: { readonly key: string }) => Effect.Effect<SettingValue>;
  readonly request: (payload: {
    readonly integration: string;
    readonly request: string;
    readonly slot: string;
    readonly input: unknown;
  }) => Effect.Effect<unknown, ConnectionRequestError>;
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
  readonly storeLoad?: (payload: {
    readonly name: string;
    readonly kind: "counter";
    readonly initial?: number | undefined;
  }) => Effect.Effect<unknown>;
  readonly storeSetCounter?: (payload: {
    readonly name: string;
    readonly value: number;
  }) => Effect.Effect<number>;
  readonly storeIncrement?: (payload: {
    readonly name: string;
    readonly by: number;
    readonly initial: number;
  }) => Effect.Effect<number>;
  readonly unitFailed?: (payload: {
    readonly unit: string;
    readonly error: string;
    readonly source?: {
      readonly file: string;
      readonly line: number;
      readonly column: number;
    } | undefined;
  }) => Effect.Effect<void>;
  readonly eventHistoryRecord?: (payload: {
    readonly name: string;
    readonly fingerprint: string;
    readonly event: Schema.Json;
  }) => Effect.Effect<HistoryRecord>;
  readonly eventHistoryQuery?: (payload: {
    readonly name: string;
    readonly limit: number;
    readonly before?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<HistoryRecord>>;
  readonly databaseExecute?: (
    input: DatabaseExecuteInput,
  ) => Effect.Effect<unknown, SqlErrorWire>;
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
          StoreLoad:
            handlers.storeLoad ??
            ((payload) => Effect.sync(() => memoryLoad(payload))),
          StoreSetCounter:
            handlers.storeSetCounter ??
            ((payload) =>
              Effect.sync(() => {
                memoryStores.set(payload.name, {
                  ...memoryStores.get(payload.name),
                  counter: payload.value,
                });
                return payload.value;
              })),
          StoreIncrement:
            handlers.storeIncrement ??
            ((payload) =>
              Effect.sync(() => {
                const current = memoryStores.get(payload.name)?.counter ?? payload.initial;
                const next = current + payload.by;
                memoryStores.set(payload.name, {
                  ...memoryStores.get(payload.name),
                  counter: next,
                });
                return next;
              })),
          UnitFailed:
            handlers.unitFailed ??
            (() => Effect.void),
          EventHistoryRecord:
            handlers.eventHistoryRecord ??
            ((payload) => Effect.sync(() => memoryHistoryRecord(payload))),
          EventHistoryQuery:
            handlers.eventHistoryQuery ??
            ((payload) => Effect.sync(() => memoryHistoryQuery(payload))),
          DatabaseExecute:
            handlers.databaseExecute ??
            ((_input) =>
              Effect.die(
                new Error("Database support is not implemented by this runtime host"),
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
