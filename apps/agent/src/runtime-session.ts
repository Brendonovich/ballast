import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Json } from "effect/Schema";
import { NodeStream } from "@effect/platform-node";
import { serveRuntimeRpc } from "@ballast/core";
import type { RuntimeHostHandlers, SettingValue } from "@ballast/core";

export interface RuntimeSettings {
  readonly get: (key: string) => string | number | boolean | ReadonlyArray<string> | undefined;
  /** Initial values copied into the worker's Settings Ref. */
  readonly snapshot?: () => Readonly<Record<string, SettingValue>>;
}

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogLine {
  readonly level: RuntimeLogLevel;
  readonly message: string;
  /** Unit annotation attached by `Ballast.withUnit`, when present. */
  readonly unitName?: string;
}

export interface RuntimeTimerFire {
  readonly name: string;
  readonly key: string;
  readonly payload: unknown;
  readonly scheduledAt: number;
  readonly dueAt: number;
  readonly firedAt: number;
  readonly lateByMs: number;
}

export interface RuntimeSessionOptions {
  readonly bundlePath: string;
  readonly generation: number;
  readonly settings: RuntimeSettings;
  readonly request: (
    integration: string,
    request: string,
    slot: string,
    input: unknown,
  ) => Effect.Effect<unknown, import("@ballast/core").ConnectionRequestError>;
  /** Timer RPCs; optional so non-service hosts keep working. */
  readonly registerTimer?: (name: string) => Effect.Effect<void>;
  readonly scheduleTimer?: (input: RuntimeTimerSchedule) => Effect.Effect<void, string>;
  readonly cancelTimer?: (input: { readonly name: string; readonly key: string }) => Effect.Effect<void>;
  /** Structured worker output; defaults to the process console. */
  readonly onLog?: (line: RuntimeLogLine) => void;
  readonly storeLoad?: RuntimeHostHandlers["storeLoad"];
  readonly storeSetCounter?: RuntimeHostHandlers["storeSetCounter"];
  readonly storeIncrement?: RuntimeHostHandlers["storeIncrement"];
  readonly eventHistoryRecord?: RuntimeHostHandlers["eventHistoryRecord"];
  readonly eventHistoryQuery?: RuntimeHostHandlers["eventHistoryQuery"];
  readonly databaseExecute?: RuntimeHostHandlers["databaseExecute"];
  readonly unitFailed?: RuntimeHostHandlers["unitFailed"];
  /** Called once if the worker exits after starting, for any reason. */
  readonly onExit?: (reason: string) => void;
}

export interface RuntimeTimerSchedule {
  readonly name: string;
  readonly key: string;
  readonly delayMs: number;
  readonly payload: Json;
  readonly payloadFingerprint: string;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
}

export interface RuntimeSession {
  readonly generation: number;
  readonly subscriptions: ReadonlySet<string>;
  /** Host end of the worker's artifact RPC channel, once the worker starts. */
  readonly artifactPort?: MessagePort;
  readonly ready: Effect.Effect<void, Error>;
  /** `undefined` while the worker is alive, the reason once it exits. */
  readonly exitReason: Effect.Effect<string | undefined>;
  readonly deliver: (topicKey: string, payload: unknown) => void;
  /** Post one durable timer fire to the worker. */
  readonly deliverTimer: (fire: RuntimeTimerFire) => void;
  /** Push live param values; the worker's next Param read sees them. */
  readonly updateParams: (values: Readonly<Record<string, SettingValue>>) => void;
  readonly close: Effect.Effect<void>;
}

const unitLine = (
  line: string,
): { readonly message: string; readonly unitName?: string } => {
  const match = /^\[unit:([^\]]+)\] (.*)$/.exec(line);
  if (match === null) return { message: line };
  const unitName = match[1];
  const message = match[2];
  if (unitName === undefined || message === undefined) return { message: line };
  return { message, unitName };
};

/**
 * One runtime worker generation. The host owns the RPC server, the worker's
 * subscriptions and the worker's lifetime; closing the session closes the RPC
 * scope and terminates the worker.
 */
export const startRuntimeSession = (
  options: RuntimeSessionOptions,
): Effect.Effect<RuntimeSession, Error> =>
  Effect.gen(function* () {
    const channel = new MessageChannel();
    const artifactChannel = new MessageChannel();
    const ready = Deferred.makeUnsafe<void, Error>();
    const subscriptions = new Set<string>();
    const scope = yield* Scope.make();

    let worker: Worker | undefined;
    let closed = false;
    let exitReported = false;
    let exitReason: string | undefined;

    const handlers: RuntimeHostHandlers = {
      ready: ({ generation }) =>
        Effect.sync(() => {
          if (generation !== options.generation) {
            Deferred.doneUnsafe(
              ready,
              Exit.fail(
                new Error(
                  `Worker ${generation} reported ready as generation ${options.generation}`,
                ),
              ),
            );
            return;
          }
          Deferred.doneUnsafe(ready, Exit.succeed(undefined));
        }),
      registerTopic: ({ key }) =>
        Effect.sync(() => {
          subscriptions.add(key);
        }),
      getSetting: ({ key }) =>
        Effect.succeed<SettingValue>(options.settings.get(key) ?? null),
      request: ({ integration, request, slot, input }) =>
        options.request(integration, request, slot, input),
      registerTimer: ({ name }) =>
        options.registerTimer === undefined
          ? Effect.die(new Error("Timer support is not implemented by this host"))
          : options.registerTimer(name),
      scheduleTimer: (input) =>
        options.scheduleTimer === undefined
          ? Effect.die(new Error("Timer support is not implemented by this host"))
          : options.scheduleTimer(input),
      cancelTimer: (input) =>
        options.cancelTimer === undefined
          ? Effect.die(new Error("Timer support is not implemented by this host"))
          : options.cancelTimer(input),
      ...(options.storeLoad === undefined ? {} : { storeLoad: options.storeLoad }),
      ...(options.storeSetCounter === undefined
        ? {}
        : { storeSetCounter: options.storeSetCounter }),
      ...(options.storeIncrement === undefined
        ? {}
        : { storeIncrement: options.storeIncrement }),
      ...(options.eventHistoryRecord === undefined
        ? {}
        : { eventHistoryRecord: options.eventHistoryRecord }),
      ...(options.eventHistoryQuery === undefined
        ? {}
        : { eventHistoryQuery: options.eventHistoryQuery }),
      ...(options.databaseExecute === undefined
        ? {}
        : { databaseExecute: options.databaseExecute }),
      ...(options.unitFailed === undefined ? {} : { unitFailed: options.unitFailed }),
    };

    const onLog =
      options.onLog ??
      ((line: RuntimeLogLine) => {
        if (line.level === "error") console.error(line.message);
        else console.log(line.message);
      });

    const levelOf = (line: string): RuntimeLogLevel => {
      if (/\b(error|fatal)\b/i.test(line)) return "error";
      if (/\b(warn|warning)\b/i.test(line)) return "warn";
      if (/\bdebug\b/i.test(line)) return "debug";
      return "info";
    };

    const session: RuntimeSession = {
      generation: options.generation,
      subscriptions,
      artifactPort: artifactChannel.port1,
      ready: Deferred.await(ready),
      exitReason: Effect.sync(() => exitReason),
      deliver: (topicKey, payload) => {
        if (closed || worker === undefined) {
          onLog({
            level: "warn",
            message: `Event ${topicKey} dropped: worker generation ${options.generation} is ${closed ? "closed" : "not started"}`,
          });
          return;
        }
        if (!subscriptions.has(topicKey)) {
          onLog({
            level: "warn",
            message: `Event ${topicKey} dropped: the worker has not registered that topic`,
          });
          return;
        }
        try {
          worker.postMessage({ kind: "event", key: topicKey, payload });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          onLog({
            level: "error",
            message: `Event ${topicKey} could not be delivered to worker generation ${options.generation}: ${message}`,
          });
        }
      },
      updateParams: (values) => {
        if (closed || worker === undefined) {
          onLog({
            level: "warn",
            message: `Params could not be delivered: worker generation ${options.generation} is ${closed ? "closed" : "not started"}`,
          });
          return;
        }
        try {
          worker.postMessage({ kind: "params", values });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          onLog({
            level: "error",
            message: `Params could not be delivered to worker generation ${options.generation}: ${message}`,
          });
        }
      },
      deliverTimer: (fire) => {
        if (closed || worker === undefined) {
          onLog({
            level: "warn",
            message: `Timer "${fire.name}" dropped: worker generation ${options.generation} is ${closed ? "closed" : "not started"}`,
          });
          return;
        }
        try {
          worker.postMessage({
            kind: "timer",
            name: fire.name,
            key: fire.key,
            payload: fire.payload,
            scheduledAt: fire.scheduledAt,
            dueAt: fire.dueAt,
            firedAt: fire.firedAt,
            lateByMs: fire.lateByMs,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          onLog({
            level: "error",
            message: `Timer "${fire.name}" could not be delivered to worker generation ${options.generation}: ${message}`,
          });
        }
      },
      close: Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        subscriptions.clear();
        artifactChannel.port1.close();
        return Scope.close(scope, Exit.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              onLog({
                level: "info",
                message: `worker generation ${options.generation} closed`,
              });
            }),
          ),
        );
      }),
    };

    const setup = Effect.gen(function* () {
      yield* serveRuntimeRpc(channel.port1, handlers).pipe(Effect.forkScoped);

      worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Worker(options.bundlePath, {
              workerData: {
                rpcPort: channel.port2,
                artifactPort: artifactChannel.port2,
                generation: options.generation,
                settings: options.settings.snapshot?.() ?? {},
              },
              transferList: [channel.port2, artifactChannel.port2],
              stdout: true,
              stderr: true,
              env: { ...process.env, ALCHEMY_PHASE: "runtime" },
            }),
        ),
        (instance) =>
          Effect.promise(() => instance.terminate()).pipe(Effect.ignore),
      );

      const emitLine = (line: string): void => {
        if (line.trim() === "") return;
        const traced = unitLine(line);
        onLog({
          level: levelOf(traced.message),
          message: traced.message,
          ...(traced.unitName === undefined ? {} : { unitName: traced.unitName }),
        });
      };

      const readLines = (
        stream: NodeJS.ReadableStream | null,
      ): Effect.Effect<void> => {
        if (stream === null) return Effect.void;
        return NodeStream.fromReadable({
          evaluate: () => stream,
          onError: () => undefined,
        }).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.sync(() => emitLine(line)).pipe(Effect.asVoid)),
          Effect.catch(() => Effect.void),
        );
      };

      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const stdout = worker?.stdout ?? null;
          const stderr = worker?.stderr ?? null;
          yield* readLines(stdout).pipe(Effect.forkScoped);
          yield* readLines(stderr).pipe(Effect.forkScoped);
          const onError = (cause: Error) => {
            Deferred.doneUnsafe(ready, Exit.fail(cause));
            if (!closed) {
              console.error(
                `[run] worker ${options.generation} errored: ${cause.message}`,
              );
            }
          };
          const onExit = (code: number) => {
            if (closed || exitReported) return;
            exitReported = true;
            exitReason = `exit code ${code}`;
            const error = new Error(
              `Worker ${options.generation} exited with code ${code}`,
            );
            Deferred.doneUnsafe(ready, Exit.fail(error));
            console.error(`[run] ${error.message}`);
            options.onExit?.(exitReason);
          };
          worker?.on("error", onError);
          worker?.on("exit", onExit);
          return () => {
            worker?.off("error", onError);
            worker?.off("exit", onExit);
          };
        }),
        (detach) => Effect.sync(detach),
      );

      yield* Deferred.await(ready);
    });

    yield* setup.pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );

    return session;
  });
