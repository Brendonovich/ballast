import { watchFile, unwatchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { diff, plan } from "@ballast/planner";
import type { ManifestDiff } from "@ballast/planner";
import type { Manifest, ParamManifest, ParamOptionSource } from "@ballast/core";
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
import { authorizeTwitchAccount } from "./twitch/auth.ts";
import {
  readStoredTwitchAccount,
  resolveDataDir,
  resolveTwitchAppConfig,
} from "./twitch/config.ts";
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

export class RuntimeParamStore implements RuntimeSettings {
  private readonly values: Map<string, string | number | boolean>;

  constructor(values: Map<string, string | number | boolean>) {
    this.values = values;
  }

  get(key: string): string | number | boolean | undefined {
    return this.values.get(key);
  }
}

const readEntry = (entry: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () => readFile(entry, "utf8"),
    catch: (cause) =>
      new Error(
        `Could not read ${entry}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

const coerceParam = (param: ParamManifest, raw: string): string | number | boolean => {
  switch (param.type) {
    case "string":
      return raw;
    case "enum":
      return raw;
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
  values: ReadonlyMap<string, string | number | boolean>,
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

      if (!available.includes(String(value))) {
        return yield* Effect.fail(
          new Error(
            `Param "${key}" value "${value}" is not available from ${cacheKey}. Available: ${
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
): Effect.Effect<Map<string, string | number | boolean>, Error> =>
  Effect.gen(function* () {
    const declared = paramMap(manifest);
    const values = new Map<string, string | number | boolean>();

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
): Effect.Effect<Map<string, string | number | boolean>, Error> => {
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

const askQuestion = (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl
    .question(question)
    .then((answer) => {
      process.stdout.write("\n");
      return answer.trim().toLowerCase().startsWith("y");
    })
    .catch(() => {
      process.stdout.write("\n");
      return false;
    })
    .finally(() => {
      rl.close();
    });
};

const askConsent = (): Promise<boolean> => askQuestion("Apply? [y/N] ");

interface AppliedState {
  readonly manifest: Manifest;
  readonly session: RuntimeSession;
  readonly content: string;
}

const startWorker = (
  entry: string,
  generation: number,
  params: RuntimeParamStore,
  request: RequestHandler,
): Effect.Effect<RuntimeSession, Error> =>
  Effect.gen(function* () {
    const bundle = yield* bundleScript(entry, generation).pipe(
      Effect.mapError((error) => new Error(error.message)),
    );
    console.log(
      `[run] bundled generation ${generation} (${bundle.bytes} bytes) -> ${bundle.path}`,
    );
    const session = yield* startRuntimeSession({
      bundlePath: bundle.path,
      generation,
      settings: params,
      request,
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
  reload: () => Effect.Effect<void>,
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<void>();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        watchFile(entry, { interval: 300 }, () => {
          Queue.offerUnsafe(events, undefined);
        });
        return () => {
          unwatchFile(entry);
        };
      }),
      (stop) => Effect.sync(stop),
    );

    return yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(events);
        // Editors often emit more than one event for a save; coalesce them.
        yield* Effect.sleep("150 millis");
        yield* Queue.clear(events);
        yield* reload();
      }),
    );
  });

/**
 * Run a script in a worker, watch its entry and hot-swap generations. Consent
 * is requested when the plan adds a scope or a connection slot.
 */
export const runScript = (options: RunOptions): Effect.Effect<never, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const entry = resolve(options.entry);
      const initialContent = yield* readEntry(entry);
      const bus = new AgentEventBus();
      const obsSlots = new Map<string, ObsSlotState>();
      const runScope = yield* Scope.Scope;

      const reauthorizeTwitch = (
        slot: string,
        scopes: ReadonlyArray<string>,
      ): Effect.Effect<boolean, Error> =>
        Effect.gen(function* () {
          if (process.stdin.isTTY !== true || process.env["CI"] === "1") return false;
          const stored = yield* Effect.tryPromise({
            try: () => readStoredTwitchAccount(slot),
            catch: (cause) =>
              new Error(
                "Could not read the stored Twitch token: " +
                  (cause instanceof Error ? cause.message : String(cause)),
              ),
          });
          if (stored === undefined) return false;

          const config = yield* Effect.try({
            try: () => resolveTwitchAppConfig(slot, options, stored),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });

          const approved = yield* Effect.promise(() =>
            askQuestion(
              "[twitch:" +
                slot +
                "] the stored token is missing scopes: " +
                scopes.join(", ") +
                ". Re-authorize now? [y/N] ",
            ),
          );
          if (!approved) return false;

          yield* authorizeTwitchAccount({
            slot,
            config,
            dataDir: resolveDataDir(),
            scopes,
          }).pipe(Effect.provide(FetchHttpClient.layer));
          return true;
        });

      const twitch = yield* startTwitchRuntime({
        options: {
          connections: options.connections,
          secrets: options.secrets,
        },
        twitchModes: options.twitchModes,
        ...(options.cloudUrl === undefined ? {} : { cloudUrl: options.cloudUrl }),
        publish: (key, payload) => bus.publish(key, payload),
        reauthorize: reauthorizeTwitch,
      });
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
            try: () => resolveObsConnectionConfig(slot, options),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
          });

          const scope = yield* Scope.fork(parentScope, "parallel");
          const driver = yield* startObsDriver({
            slot,
            url: config.url,
            ...(config.password === undefined ? {} : { password: config.password }),
            topics,
            publish: (key, payload) => bus.publish(key, payload),
          }).pipe(Scope.provide(scope));
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

      const initialManifest = yield* plan(entry).pipe(
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

      let applied: AppliedState = {
        manifest: initialManifest,
        session: yield* startWorker(
          entry,
          0,
          new RuntimeParamStore(initialValues),
          requestHandler,
        ),
        content: initialContent,
      };
      let lastPlannedContent = initialContent;
      let generation = 1;
      bus.setActive(applied.session);

      yield* Effect.addFinalizer(() => applied.session.close);
      yield* startFakeDriver((key, payload) => bus.publish(key, payload)).pipe(
        Effect.forkScoped,
      );

      console.log(`[run] watching ${entry}`);

      const reload = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const content = yield* readEntry(entry).pipe(
            Effect.catch((error) => {
              console.error(`[run] ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (content === undefined || content === lastPlannedContent) return;
          lastPlannedContent = content;

          const nextManifest = yield* plan(entry).pipe(
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
            const approved = yield* Effect.promise(askConsent);
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
            entry,
            generation++,
            new RuntimeParamStore(nextValues),
            requestHandler,
          ).pipe(
            Effect.catch((error) => {
              console.error(`[run] could not start worker: ${error.message}`);
              return Effect.succeed(undefined);
            }),
          );
          if (nextSession === undefined) return;

          bus.setActive(nextSession);
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
