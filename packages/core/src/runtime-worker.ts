import { MessagePort, parentPort, workerData } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Scope } from "effect/Scope";
import { ScriptPhase } from "./phase.ts";
import { makeRuntimeRpcClient } from "./runtime-rpc.ts";
import { evaluateScript } from "./script.ts";
import { EventBus, RequestClients, Settings } from "./services.ts";
import type {
  EventBusService,
  RequestClientsService,
  SettingsService,
} from "./services.ts";

interface RuntimeWorkerData {
  readonly rpcPort: MessagePort;
  readonly generation: number;
}

interface RuntimeEventMessage {
  readonly kind: "event";
  readonly key: string;
  readonly payload: unknown;
}

const plainLogger = Logger.make<unknown, void>(({ message, cause }) => {
  const text = Array.isArray(message)
    ? message.map((part) => String(part)).join(" ")
    : String(message);
  console.log(text);
  if (cause.reasons.length > 0) {
    console.error(Cause.pretty(cause));
  }
});

const isScriptEffect = (value: unknown): value is Effect.Effect<unknown, unknown, never> =>
  Effect.isEffect(value);

const isRuntimeEffect = (value: unknown): value is Effect.Effect<unknown, unknown, never> =>
  Effect.isEffect(value);

const isRuntimeEventMessage = (value: unknown): value is RuntimeEventMessage =>
  Predicate.isObject(value) &&
  Predicate.hasProperty("kind")(value) &&
  value.kind === "event" &&
  Predicate.hasProperty("key")(value) &&
  Predicate.isString(value.key) &&
  Predicate.hasProperty("payload")(value);

const parseWorkerData = (value: unknown): RuntimeWorkerData => {
  if (!Predicate.isObject(value)) {
    throw new Error("Runtime worker started without workerData");
  }
  if (!Predicate.hasProperty("rpcPort")(value) || !(value.rpcPort instanceof MessagePort)) {
    throw new Error("Runtime worker started without an RPC MessagePort");
  }
  if (
    !Predicate.hasProperty("generation")(value) ||
    !Predicate.isNumber(value.generation)
  ) {
    throw new Error("Runtime worker started without a generation");
  }
  return { rpcPort: value.rpcPort, generation: value.generation };
};

const runtimeProgram = (
  script: Effect.Effect<void, unknown, never>,
): Effect.Effect<void, unknown, Scope> =>
  Effect.gen(function* () {
    const data = parseWorkerData(workerData);
    const port = parentPort;
    if (port === null) {
      return yield* Effect.fail(new Error("Runtime worker has no parentPort"));
    }

    const client = yield* makeRuntimeRpcClient(data.rpcPort);
    const handlers = new Map<
      string,
      Set<(event: unknown) => Effect.Effect<void, never, never>>
    >();

    const eventBus: EventBusService = {
      subscribe: (key, handler) =>
        Effect.gen(function* () {
          const dispatch = (event: unknown) => handler(event as Parameters<typeof handler>[0]);
          const existing = handlers.get(key);
          if (existing === undefined) {
            handlers.set(key, new Set([dispatch]));
          } else {
            existing.add(dispatch);
          }
          yield* client.RegisterTopic({ key }).pipe(Effect.orDie);
        }),
    };

    const settings: SettingsService = {
      get: (key) =>
        client.GetSetting({ key }).pipe(
          Effect.orDie,
          Effect.map((value) => (value === null ? undefined : value)),
        ),
    };

    const requestClients: RequestClientsService = {
      client: (request) =>
        Effect.sync(() => {
          const outputSchema = request.outputSchema;
          return (input) =>
            client
              .Request({
                integration: request.integration,
                request: request.request,
                slot: request.slot,
                input,
              })
              .pipe(
                Effect.orDie,
                Effect.flatMap((value) => {
                  if (outputSchema === undefined) {
                    return Effect.die(
                      new Error(
                        `Request "${request.request}" has no output schema; the runtime cannot decode its result`,
                      ),
                    );
                  }
                  return Effect.sync(() =>
                    Schema.decodeUnknownSync(outputSchema)(value),
                  );
                }),
              );
        }),
    };

    yield* Effect.gen(function* () {
      const context = yield* Effect.context<never>();

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (message: unknown) => {
            if (!isRuntimeEventMessage(message)) return;
            const subscribed = handlers.get(message.key);
            if (subscribed === undefined) return;
            for (const handler of subscribed) {
              Effect.runForkWith(context)(
                handler(message.payload).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError(`Event handler failed for ${message.key}`, cause),
                  ),
                ),
              );
            }
          };
          port.on("message", listener);
          return () => {
            port.off("message", listener);
          };
        }),
        (release) => Effect.sync(release),
      );

      const runtime = yield* evaluateScript(script, "runtime");

      yield* client.Ready({ generation: data.generation }).pipe(Effect.orDie);
      console.log(`[runtime] generation ${data.generation} ready`);

      const exported = yield* runtime.exports;
      const program = exported["program"];
      if (program !== undefined && isRuntimeEffect(program)) {
        yield* program;
      }

      // Event handlers and `Ballast.run` loops keep the worker alive. A script
      // with neither still stays up until the host terminates it.
      yield* Effect.never;
    }).pipe(
      Effect.provideService(ScriptPhase, "runtime"),
      Effect.provideService(EventBus, eventBus),
      Effect.provideService(Settings, settings),
      Effect.provideService(RequestClients, requestClients),
    );
  });

/**
 * Run a bundled script's init in runtime phase and keep the worker alive until
 * the host terminates it. Called by the generated bundle entry.
 */
export const runRuntimeWorker = async (script: unknown): Promise<void> => {
  if (!isScriptEffect(script)) {
    throw new Error("Runtime bundle must default-export an Effect (a Ballast script)");
  }
  await Effect.runPromise(
    Effect.scoped(runtimeProgram(script)).pipe(
      Effect.provide(Logger.layer([plainLogger])),
    ),
  );
};
