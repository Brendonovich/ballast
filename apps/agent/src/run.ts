import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { FetchHttpClient } from "effect/http";
import { diff, plan } from "@ballast/planner";
import type { ManifestDiff } from "@ballast/planner";
import { makeTimerScheduler } from "@ballast/core";
import type { Manifest, ParamManifest, ParamOptionSource, TimerManifest } from "@ballast/core";
import { RequestSchemas } from "@ballast/module-obs";
import { AgentEventBus } from "./event-bus.ts";
import { bundleScript } from "./bundle.ts";
import { resolveObsConnectionConfig } from "./connection-config.ts";
import type { ConnectionOptions } from "./connection-config.ts";
import { handleFakeRequest, startFakeDriver } from "./fake.ts";
import { startObsDriver } from "./obs-driver.ts";
import type { ObsDriver } from "./obs-driver.ts";
import { startRuntimeSession } from "./runtime-session.ts";
import type { RuntimeSession, RuntimeSettings } from "./runtime-session.ts";
import { startRunDatabases } from "./service/database.ts";
import type { RunDatabases } from "./service/database.ts";
import { authorizeTwitchAccount } from "./twitch/auth.ts";
import {
  readStoredTwitchAccount,
  resolveDataDir,
  resolveTwitchAppConfig,
  twitchEnvKeys,
} from "./twitch/config.ts";
import { readEnvironment } from "./service/config.ts";
import type { TwitchMode } from "./twitch/config.ts";
import { startTwitchRuntime } from "./twitch/runtime.ts";

export interface RunOptions extends ConnectionOptions {
  readonly entry: string;
  readonly params: ReadonlyMap<string, string>;
  readonly twitchModes: ReadonlyMap<string, TwitchMode>;
  readonly cloudUrl: string | undefined;
}

type RequestHandler = (
  integration: string,
  request: string,
  slot: string,
  input: unknown,
) => Effect.Effect<unknown, string>;

type RunParamValue = string | number | boolean | ReadonlyArray<string>;

export class RuntimeParamStore implements RuntimeSettings {
  private readonly values: Map<string, RunParamValue>;

  constructor(values: Map<string, RunParamValue>) {
    this.values = values;
  }

  get(key: string): RunParamValue | undefined {
    return this.values.get(key);
  }

  snapshot(): Readonly<Record<string, RunParamValue>> {
    return Object.fromEntries(this.values);
  }
}

const resolveDir = (path: Path.Path): Effect.Effect<string> =>
  path.fromFileUrl(new URL(".", import.meta.url)).pipe(Effect.orDie);

const readEntry = (
  entry: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(entry).pipe(
      Effect.mapError((cause) => new Error(`Could not read ${entry}: ${cause.message}`)),
    );
  });

const coerceParam = (param: ParamManifest, raw: string): RunParamValue => {
  switch (param.type) {
    case "string":
      return raw;
    case "enum":
      return raw;
    case "strings":
      return raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Param "${param.key}" expects a number, got "${raw}"`);
      }
      return value;
    }
    case "boolean": {
      const normalized = raw.toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      throw new Error(`Param "${param.key}" expects true or false, got "${raw}"`);
    }
  }
};

const paramMap = (manifest: Manifest): Map<string, ParamManifest> =>
  new Map(manifest.params.map((param) => [param.key, param]));

export type ParamOptionResolver = (
  source: ParamOptionSource,
) => Effect.Effect<ReadonlyArray<string>, Error>;

const optionSourceKey = (source: ParamOptionSource): string =>
  `${source.integration}/${source.slot}/${source.source}`;

const validateOptions = (
  declared: ReadonlyMap<string, ParamManifest>,
  values: ReadonlyMap<string, RunParamValue>,
  resolveOptions: ParamOptionResolver,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const resolved = new Map<string, ReadonlyArray<string>>();

    for (const [key, value] of values) {
      const param = declared.get(key);
      if (param === undefined || param.options === undefined) continue;

      const source = param.options;
      const cacheKey = optionSourceKey(source);
      let available = resolved.get(cacheKey);
      if (available === undefined) {
        available = yield* resolveOptions(source).pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `Could not resolve options for param "${key}" (${cacheKey}): ${error.message}`,
              ),
          ),
        );
        resolved.set(cacheKey, available);
      }

      const selected = Array.isArray(value) ? value : [String(value)];
      const rejected = selected.filter((entry) => !available.includes(entry));
      if (rejected.length > 0) {
        const shown = Array.isArray(value) ? rejected.join(", ") : String(value);
        return yield* Effect.fail(
          new Error(
            `Param "${key}" value "${shown}" is not available from ${cacheKey}. Available: ${
              available.length === 0 ? "(none)" : available.join(", ")
            }`,
          ),
        );
      }
    }
  });

/**
 * Validate CLI params against the initial manifest. Unknown keys and required
 * params without a value are errors; dynamic options are resolved and checked
 * when a resolver is provided.
 */
export const parseParamValues = (
  manifest: Manifest,
  inputs: ReadonlyMap<string, string>,
  resolveOptions?: ParamOptionResolver,
): Effect.Effect<Map<string, RunParamValue>, Error> =>
  Effect.gen(function* () {
    const declared = paramMap(manifest);
    const values = new Map<string, RunParamValue>();

    for (const [key, raw] of inputs) {
      const param = declared.get(key);
      if (param === undefined) {
        const keys = [...declared.keys()].sort();
        return yield* Effect.fail(
          new Error(
            `Unknown param "${key}". Declared params: ${keys.length === 0 ? "(none)" : keys.join(", ")}`,
          ),
        );
      }
      const value = yield* Effect.try({
        try: () => coerceParam(param, raw),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      values.set(key, value);
    }

    for (const param of manifest.params) {
      if (param.default === undefined && !values.has(param.key)) {
        return yield* Effect.fail(
          new Error(
            `Missing required param "${param.key}"; provide --param ${param.key}=<value>`,
          ),
        );
      }
    }

    if (resolveOptions !== undefined) {
      yield* validateOptions(declared, values, resolveOptions);
    }

    return values;
  });

/**
 * Build values for a new manifest generation. Params removed from the manifest
 * are dropped; new params fall back to the script's defaults.
 */
const refreshParamValues = (
  manifest: Manifest,
  inputs: ReadonlyMap<string, string>,
  resolveOptions?: ParamOptionResolver,
): Effect.Effect<Map<string, RunParamValue>, Error> => {
  const declared = paramMap(manifest);
  const kept = new Map([...inputs].filter(([key]) => declared.has(key)));
  return parseParamValues(manifest, kept, resolveOptions);
};

const manifestEquals = (left: Manifest, right: Manifest): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const printDiff = (value: ManifestDiff): void => {
  console.log("[run] plan diff:");
  console.log(JSON.stringify(value, null, 2));
};

const askQuestion = (
  question: string,
): Effect.Effect<boolean, never, Terminal.Terminal> =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal;
    yield* terminal.display(question).pipe(Effect.orDie);
    const answer = yield* terminal.readLine.pipe(
      Effect.catchIf(Terminal.isQuitError, () => Effect.succeed("")),
    );
    yield* terminal.display("\n").pipe(Effect.orDie);
    return answer.trim().toLowerCase().startsWith("y");
  });

const askConsent = (): Effect.Effect<boolean, never, Terminal.Terminal> =>
  askQuestion("Apply? [y/N] ");

interface AppliedState {
  readonly manifest: Manifest;
  readonly session: RuntimeSession;
  readonly content: string;
}

interface RunTimerHandlers {
  readonly registerTimer: (name: string) => Effect.Effect<void>;
  readonly scheduleTimer: (input: {
    readonly name: string;
    readonly key: string;
    readonly delayMs: number;
    readonly payload: import("effect/Schema").Json;
    readonly payloadFingerprint: string;
    readonly onStale: "drop" | "deliver";
    readonly maxAgeMs: number;
  }) => Effect.Effect<void, string>;
  readonly cancelTimer: (input: { readonly name: string; readonly key: string }) => Effect.Effect<void>;
}

const startWorker = (
  platform: Context.Context<
    | ChildProcessSpawner
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
    | Stdio.Stdio
    | Terminal.Terminal
  >,
  entry: string,
  generation: number,
  params: RuntimeParamStore,
  request: RequestHandler,
  timers: RunTimerHandlers,
  databases: RunDatabases,
) =>
  Effect.gen(function* () {
    const bundle = yield* Effect.provideContext(
      bundleScript(entry, generation),
      platform,
    ).pipe(Effect.mapError((error) => new Error(error.message)));
    console.log(
      `[run] bundled generation ${generation} (${bundle.bytes} bytes) -> ${bundle.path}`,
    );
    const session = yield* startRuntimeSession({
      bundlePath: bundle.path,
      generation,
      settings: params,
      request,
      ...timers,
      databaseExecute: databases.execute,
    });
    console.log(`[run] started worker generation ${generation}`);
    return session;
  });

interface ObsSlotState {
  readonly driver: ObsDriver;
  readonly scope: Scope.Closeable;
  readonly topics: string;
}

const obsTopics = (manifest: Manifest, slot: string): ReadonlyArray<string> =>
  manifest.topics
    .filter((topic) => topic.integration === "obs" && topic.slot === slot)
    .map((topic) => topic.topic);

const obsSlotsFor = (manifest: Manifest): ReadonlyArray<string> =>
  manifest.connections
    .filter((connection) => connection.integration === "obs" && connection.location !== "cloud")
    .map((connection) => connection.slot);

const watchEntry = (
  entry: string,
  reload: () => Effect.Effect<void, never, FileSystem.FileSystem | Terminal.Terminal>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.watch(entry).pipe(
      // Editors often emit more than one event for a save; coalesce them.
      Stream.debounce("150 millis"),
      Stream.runForEach(() => reload()),
      Effect.catch((error) => {
        console.error(`[run] could not watch ${entry}: ${error.message}`);
        return Effect.never;
      }),
    );
  });

/**
 * Run a script in a worker, watch its entry and hot-swap generations. Consent
 * is requested when the plan adds a scope or a connection slot.
 */
export const runScript = (options: RunOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const platform = yield* Effect.context<
        | ChildProcessSpawner
        | Crypto.Crypto
        | FileSystem.FileSystem
        | Path.Path
        | Scope.Scope
        | Stdio.Stdio
        | Terminal.Terminal
      >();
      const provide = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | ChildProcessSpawner
          | Crypto.Crypto
          | FileSystem.FileSystem
          | Path.Path
          | Scope.Scope
          | Stdio.Stdio
          | Terminal.Terminal
        >,
      ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
      const env = yield* readEnvironment([
        "CI",
        "BALLAST_CI",
        "XDG_DATA_HOME",
        "LOCALAPPDATA",
        "HOME",
      ]);
      const entry = path.resolve(options.entry);
      const databases = yield* startRunDatabases(
        path.join(path.dirname(entry), ".ballast", "db"),
      );
      yield* Effect.addFinalizer(() => databases.close);
      const initialContent = yield* readEntry(entry);
      const bus = new AgentEventBus();
      const obsSlots = new Map<string, ObsSlotState>();
      const runScope = yield* Scope.Scope;

      const reauthorizeTwitch = (
        slot: string,
        scopes: ReadonlyArray<string>,
      ): Effect.Effect<boolean, Error> =>
        provide(Effect.gen(function* () {
          const stdio = yield* Stdio.Stdio;
          const stdinIsTerminal = yield* stdio.stdinIsTerminal;
          if (!stdinIsTerminal || env["CI"] === "1") return false;
          const stored = yield* readStoredTwitchAccount(slot).pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  "Could not read the stored Twitch token: " +
                    (cause instanceof Error ? cause.message : String(cause)),
                ),
            ),
          );
          if (stored === undefined) return false;

          const twitchEnv = {
            ...env,
            ...(yield* readEnvironment(twitchEnvKeys(slot))),
          };
          const config = yield* Effect.try({
            try: () => resolveTwitchAppConfig(slot, options, stored, twitchEnv),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });

          const approved = yield* askQuestion(
            "[twitch:" +
              slot +
              "] the stored token is missing scopes: " +
              scopes.join(", ") +
              ". Re-authorize now? [y/N] ",
          );
          if (!approved) return false;

          yield* authorizeTwitchAccount({
            slot,
            config,
            dataDir: resolveDataDir(path, env),
            scopes,
          }).pipe(Effect.provide(FetchHttpClient.layer));
          return true;
        }));

      const twitch = yield* provide(startTwitchRuntime({
        options: {
          connections: options.connections,
          secrets: options.secrets,
        },
        twitchModes: options.twitchModes,
        ...(options.cloudUrl === undefined ? {} : { cloudUrl: options.cloudUrl }),
        publish: (key, payload) => bus.publish(key, payload),
        reauthorize: reauthorizeTwitch,
      }));
      yield* Effect.addFinalizer(() => twitch.close);

      const ensureObs = (
        manifest: Manifest,
        slot: string,
        parentScope: Scope.Scope,
      ): Effect.Effect<ObsDriver, Error> =>
        Effect.gen(function* () {
          const topics = obsTopics(manifest, slot);
          const topicsKey = topics.join(",");
          const existing = obsSlots.get(slot);
          if (existing !== undefined && existing.topics === topicsKey) {
            return existing.driver;
          }
          if (existing !== undefined) {
            yield* Scope.close(existing.scope, Exit.void);
            obsSlots.delete(slot);
          }

          const config = yield* Effect.try({
            try: () => resolveObsConnectionConfig(slot, options, env),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });

          const scope = yield* Scope.fork(parentScope, "parallel");
          const driver = yield* provide(startObsDriver({
            slot,
            url: config.url,
            ...(config.password === undefined ? {} : { password: config.password }),
            topics,
            publish: (key, payload) => bus.publish(key, payload),
          })).pipe(Scope.provide(scope));
          obsSlots.set(slot, { driver, scope, topics: topicsKey });
          return driver;
        });

      const resolveOptionsFor =
        (manifest: Manifest): ParamOptionResolver =>
        (source) =>
          Effect.gen(function* () {
            if (source.integration !== "obs") {
              return yield* Effect.fail(
                new Error(
                  `No options provider for ${source.integration}/${source.slot}/${source.source}`,
                ),
              );
            }
            if (source.source !== "scenes") {
              return yield* Effect.fail(
                new Error(`Unknown OBS option source "${source.source}"`),
              );
            }

            const driver = yield* ensureObs(manifest, source.slot, runScope);
            yield* driver.ready.pipe(
              Effect.timeout("10 seconds"),
              Effect.mapError(
                () =>
                  new Error(
                    `OBS obs/${source.slot} did not connect within 10s (${driver.url})`,
                  ),
              ),
            );

            const response = yield* driver
              .request("GetSceneList", {})
              .pipe(Effect.mapError((error) => new Error(error)));
            const decoded = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(RequestSchemas.GetSceneList.output)(response),
              catch: (cause) =>
                new Error(
                  `Unexpected GetSceneList response: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                ),
            });
            const scenes = decoded.scenes.flatMap((scene) => {
              const name = scene["sceneName"];
              return typeof name === "string" ? [name] : [];
            });
            if (scenes.length === 0) {
              return yield* Effect.fail(
                new Error(`OBS obs/${source.slot} returned no scenes`),
              );
            }
            return scenes;
          });

      const initialManifest = yield* plan(entry, {
        resolveDir: yield* resolveDir(path),
      }).pipe(
        Effect.mapError((error) => new Error(error.message)),
      );

      yield* twitch.sync(initialManifest).pipe(
        Effect.mapError((error) => new Error(error.message)),
      );

      for (const slot of obsSlotsFor(initialManifest)) {
        yield* ensureObs(initialManifest, slot, runScope);
      }

      const initialValues = yield* parseParamValues(
        initialManifest,
        options.params,
        resolveOptionsFor(initialManifest),
      );

      const requestHandler: RequestHandler = (integration, request, slot, input) => {
        if (integration === "fake") return handleFakeRequest(request, slot, input);
        if (integration === "obs") {
          const state = obsSlots.get(slot);
          if (state === undefined) {
            return Effect.fail(`No OBS connection for slot "${slot}"`);
          }
          return state.driver.request(request, input);
        }
        if (integration === "twitch") {
          return twitch.request(slot, request, input).pipe(
            Effect.mapError((error) => error.message),
          );
        }
        return Effect.fail(`No runtime handler for integration "${integration}"`);
      };

      // In-process `ballast run` keeps timers in memory. The service uses the
      // persisted project store; here a Ctrl-C loses pending timers.
      let currentManifest: Manifest = initialManifest;
      let currentSession: RuntimeSession | undefined;
      const clock = yield* Effect.clockWith((value) => Effect.succeed(value));
      const timerScheduler = yield* makeTimerScheduler({
        clock,
        onFire: (fire) =>
          Effect.gen(function* () {
            const declaration = currentManifest.timers.find(
              (timer) => timer.name === fire.timer,
            );
            if (declaration === undefined) {
              console.error(
                `[run] timer "${fire.timer}" fired without a declaration; dropped`,
              );
              return;
            }
            if (currentSession === undefined) return;
            currentSession.deliverTimer({
              name: fire.timer,
              key: fire.key,
              payload: fire.payload,
              scheduledAt: fire.scheduledAt,
              dueAt: fire.dueAt,
              firedAt: fire.firedAt,
              lateByMs: fire.lateByMs,
            });
            console.log(
              `[run] timer "${fire.timer}" fired for ${fire.key} (late ${fire.lateByMs}ms)`,
            );
          }),
      });
      const timerHandlers = (manifest: Manifest): RunTimerHandlers => ({
        registerTimer: (name) =>
          manifest.timers.some((timer) => timer.name === name)
            ? Effect.void
            : Effect.die(
                new Error(`Timer "${name}" was registered without a declaration`),
              ),
        scheduleTimer: (input) => {
          const declaration: TimerManifest | undefined = manifest.timers.find(
            (timer) => timer.name === input.name,
          );
          if (declaration === undefined) {
            return Effect.fail(
              `Timer "${input.name}" is not declared by the running manifest`,
            );
          }
          if (input.payloadFingerprint !== declaration.payloadFingerprint) {
            return Effect.fail(
              `Timer "${input.name}" payload fingerprint does not match the running manifest`,
            );
          }
          if (
            input.onStale !== declaration.onStale ||
            input.maxAgeMs !== declaration.maxAgeMs
          ) {
            return Effect.fail(
              `Timer "${input.name}" policy does not match the running manifest`,
            );
          }
          return timerScheduler.schedule({
            scriptId: "run",
            timer: input.name,
            key: input.key,
            delayMs: input.delayMs,
            payload: input.payload,
            payloadFingerprint: input.payloadFingerprint,
            onStale: input.onStale,
            maxAgeMs: input.maxAgeMs,
          });
        },
        cancelTimer: (input) =>
          timerScheduler.cancel("run", input.name, input.key),
      });

      let applied: AppliedState = {
        manifest: initialManifest,
        session: yield* startWorker(
          platform,
          entry,
          0,
          new RuntimeParamStore(initialValues),
          requestHandler,
          timerHandlers(initialManifest),
          databases,
        ),
        content: initialContent,
      };
      currentSession = applied.session;
      let lastPlannedContent = initialContent;
      let generation = 1;
      bus.setActive(applied.session);

      yield* Effect.addFinalizer(() => applied.session.close);
      yield* startFakeDriver((key, payload) => bus.publish(key, payload)).pipe(
        Effect.forkScoped,
      );

      console.log(`[run] watching ${entry}`);

      const reload = () =>
        Effect.gen(function* () {
          const content = yield* readEntry(entry).pipe(
            Effect.catch((error) => {
              console.error(`[run] ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (content === undefined || content === lastPlannedContent) return;
          lastPlannedContent = content;

          const nextManifest = yield* plan(entry, {
            resolveDir: yield* resolveDir(path),
          }).pipe(
            Effect.mapError((error) => new Error(error.message)),
            Effect.catch((error) => {
              console.error(`[run] plan failed: ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (nextManifest === undefined) return;

          const changes = diff(applied.manifest, nextManifest);
          if (changes.requiresConsent) {
            printDiff(changes);
            const approved = yield* askConsent();
            if (!approved) {
              console.log(
                `[run] update rejected; keeping worker generation ${applied.session.generation}`,
              );
              return;
            }
            console.log("[run] update approved");
          } else if (!manifestEquals(applied.manifest, nextManifest)) {
            console.log("[run] applying update (no new permissions)");
          } else {
            console.log("[run] script changed; restarting worker");
          }

          for (const slot of obsSlotsFor(nextManifest)) {
            yield* ensureObs(nextManifest, slot, runScope).pipe(
              Effect.catch((error) => {
                console.error(`[run] could not connect OBS: ${error.message}`);
                return Effect.succeed(undefined);
              }),
            );
          }

          const declared = new Set(obsSlotsFor(nextManifest));
          for (const [slot, state] of obsSlots) {
            if (declared.has(slot)) continue;
            yield* Scope.close(state.scope, Exit.void);
            obsSlots.delete(slot);
          }

          const twitchSynced = yield* twitch.sync(nextManifest).pipe(
            Effect.as(true),
            Effect.catch((error) => {
              console.error(`[run] twitch: ${error.message}`);
              return Effect.succeed(false);
            }),
          );
          if (!twitchSynced) {
            console.log(
              `[run] keeping worker generation ${applied.session.generation}; Twitch did not apply`,
            );
            return;
          }

          const nextValues = yield* refreshParamValues(
            nextManifest,
            options.params,
            resolveOptionsFor(nextManifest),
          ).pipe(
            Effect.catch((error) => {
              console.error(`[run] invalid params: ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (nextValues === undefined) return;

          const nextSession = yield* startWorker(
            platform,
            entry,
            generation++,
            new RuntimeParamStore(nextValues),
            requestHandler,
            timerHandlers(nextManifest),
            databases,
          ).pipe(
            Effect.catch((error) => {
              console.error(`[run] could not start worker: ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (nextSession === undefined) return;

          const snapshot = yield* timerScheduler.snapshot;
          const declarations = new Map(
            nextManifest.timers.map((timer) => [timer.name, timer]),
          );
          yield* timerScheduler.restore({
            version: 1,
            timers: snapshot.timers.filter((timer) => {
              const declaration = declarations.get(timer.timer);
              return (
                timer.state === "pending" &&
                declaration !== undefined &&
                declaration.payloadFingerprint === timer.payloadFingerprint
              );
            }),
          });

          bus.setActive(nextSession);
          currentManifest = nextManifest;
          currentSession = nextSession;
          const previous = applied.session;
          applied = {
            manifest: nextManifest,
            session: nextSession,
            content,
          };
          yield* previous.close;
        });

      return yield* watchEntry(entry, reload);
    }),
  );
