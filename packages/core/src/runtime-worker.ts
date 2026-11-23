import { MessagePort, parentPort, workerData } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
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
import { TimerRuntime } from "./timer.ts";
import type { TimerFire, TimerRuntimeService } from "./timer.ts";

interface RuntimeWorkerData {
  readonly rpcPort: MessagePort;
  readonly generation: number;
}

interface RuntimeEventMessage {
  readonly kind: "event";
  readonly key: string;
  readonly payload: unknown;
}

interface RuntimeTimerMessage {
  readonly kind: "timer";
  readonly name: string;
  readonly key: string;
  readonly payload: unknown;
  readonly scheduledAt: number;
  readonly dueAt: number;
  readonly firedAt: number;
  readonly lateByMs: number;
}

interface TimerRegistration {
  readonly handler: (
    fire: TimerFire<unknown>,
  ) => Effect.Effect<void, never, never>;
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

const isRuntimeTimerMessage = (value: unknown): value is RuntimeTimerMessage =>
  Predicate.isObject(value) &&
  Predicate.hasProperty("kind")(value) &&
  value.kind === "timer" &&
  Predicate.hasProperty("name")(value) &&
  Predicate.isString(value.name) &&
  Predicate.hasProperty("key")(value) &&
  Predicate.isString(value.key) &&
  Predicate.hasProperty("payload")(value) &&
  Predicate.hasProperty("scheduledAt")(value) &&
  Predicate.isNumber(value.scheduledAt) &&
  Predicate.hasProperty("dueAt")(value) &&
  Predicate.isNumber(value.dueAt) &&
  Predicate.hasProperty("firedAt")(value) &&
  Predicate.isNumber(value.firedAt) &&
  Predicate.hasProperty("lateByMs")(value) &&
  Predicate.isNumber(value.lateByMs);

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

    const timerHandlers = new Map<string, Set<TimerRegistration>>();

    const timerRuntime: TimerRuntimeService = {
      subscribe: (timer, handler) =>
        Effect.gen(function* () {
          const dispatch = (fire: TimerFire<unknown>): Effect.Effect<void> =>
            Effect.suspend(() =>
              handler({
                ...fire,
                payload: Schema.decodeUnknownSync(timer.codec)(fire.payload),
              }),
            );
          const existing = timerHandlers.get(timer.name);
          if (existing === undefined) {
            timerHandlers.set(timer.name, new Set([{ handler: dispatch }]));
          } else {
            existing.add({ handler: dispatch });
          }
          yield* client.RegisterTimer({ name: timer.name }).pipe(Effect.orDie);
        }),
      schedule: (timer, input) =>
        Effect.gen(function* () {
          const payload = Schema.encodeUnknownSync(timer.codec)(input.payload);
          yield* client
            .ScheduleTimer({
              name: timer.name,
              key: input.key,
              delayMs: Duration.toMillis(input.duration),
              payload,
              payloadFingerprint: timer.payloadFingerprint,
              onStale: timer.onStale,
              maxAgeMs: timer.maxAgeMs,
            })
            .pipe(Effect.orDie);
        }),
      cancel: (timer, key) =>
        client.CancelTimer({ name: timer.name, key }).pipe(Effect.orDie),
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
            if (isRuntimeEventMessage(message)) {
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
              return;
            }

            if (!isRuntimeTimerMessage(message)) return;
            const subscribed = timerHandlers.get(message.name);
            if (subscribed === undefined) return;
            const fire: TimerFire<unknown> = {
              timer: message.name,
              key: message.key,
              payload: message.payload,
              scheduledAt: message.scheduledAt,
              dueAt: message.dueAt,
              firedAt: message.firedAt,
              lateByMs: message.lateByMs,
            };
            for (const registration of subscribed) {
              Effect.runForkWith(context)(
                registration.handler(fire).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError(
                      `Timer handler failed for ${message.name}`,
                      cause,
                    ),
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
      Effect.provideService(TimerRuntime, timerRuntime),
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
