import { createInterface } from "node:readline";
import { MessageChannel, Worker } from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { serveRuntimeRpc } from "@ballast/core";
import type { RuntimeHostHandlers, SettingValue } from "@ballast/core";

export interface RuntimeSettings {
  readonly get: (key: string) => string | number | boolean | undefined;
}

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogLine {
  readonly level: RuntimeLogLevel;
  readonly message: string;
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
  ) => Effect.Effect<unknown, string>;
  /** Structured worker output; defaults to the process console. */
  readonly onLog?: (line: RuntimeLogLine) => void;
}

export interface RuntimeSession {
  readonly generation: number;
  readonly subscriptions: ReadonlySet<string>;
  readonly ready: Effect.Effect<void, Error>;
  readonly deliver: (topicKey: string, payload: unknown) => void;
  readonly close: Effect.Effect<void>;
}

/**
 * One runtime worker generation. The host owns the RPC server, the worker's
 * subscriptions and the worker's lifetime; closing the session closes the RPC
 * server scope and terminates the worker.
 */
export const startRuntimeSession = (
  options: RuntimeSessionOptions,
): Effect.Effect<RuntimeSession, Error> =>
  Effect.gen(function* () {
    const channel = new MessageChannel();
    const ready = Deferred.makeUnsafe<void, Error>();
    const subscriptions = new Set<string>();
    const scope = yield* Scope.make();

    let worker: Worker | undefined;
    let closed = false;

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
      ready: Deferred.await(ready),
      deliver: (topicKey, payload) => {
        if (closed || worker === undefined || !subscriptions.has(topicKey)) return;
        worker.postMessage({ kind: "event", key: topicKey, payload });
      },
      close: Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        subscriptions.clear();
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
                generation: options.generation,
              },
              transferList: [channel.port2],
              stdout: true,
              stderr: true,
              env: { ...process.env, ALCHEMY_PHASE: "runtime" },
            }),
        ),
        (instance) =>
          Effect.promise(() => instance.terminate()).pipe(Effect.ignore),
      );

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const readers: Array<ReturnType<typeof createInterface>> = [];
          if (worker?.stdout !== null && worker?.stdout !== undefined) {
            const reader = createInterface({ input: worker.stdout });
            reader.on("line", (line) => {
              if (line.trim() !== "") onLog({ level: levelOf(line), message: line });
            });
            readers.push(reader);
          }
          if (worker?.stderr !== null && worker?.stderr !== undefined) {
            const reader = createInterface({ input: worker.stderr });
            reader.on("line", (line) => {
              if (line.trim() !== "") onLog({ level: levelOf(line), message: line });
            });
            readers.push(reader);
          }
          const onError = (cause: Error) => {
            Deferred.doneUnsafe(ready, Exit.fail(cause));
            if (!closed) {
              console.error(
                `[run] worker ${options.generation} errored: ${cause.message}`,
              );
            }
          };
          const onExit = (code: number) => {
            if (closed) return;
            const error = new Error(
              `Worker ${options.generation} exited with code ${code}`,
            );
            Deferred.doneUnsafe(ready, Exit.fail(error));
            console.error(`[run] ${error.message}`);
          };
          worker?.on("error", onError);
          worker?.on("exit", onExit);
          return () => {
            worker?.off("error", onError);
            worker?.off("exit", onExit);
            for (const reader of readers) reader.close();
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
