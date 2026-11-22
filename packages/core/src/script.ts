import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Output from "alchemy/Output";
import * as OutputModule from "alchemy/Output";
import { Platform } from "alchemy/Platform";
import { Resource } from "alchemy/Resource";
import type { BaseRuntimeContext } from "alchemy/RuntimeContext";
import { packEnvValue, unpackEnvValue } from "alchemy/RuntimeContext";
import { currentPhase, ScriptPhase } from "./phase.ts";
import type { Phase } from "./phase.ts";
import { EventHostLive } from "./topic.ts";
import { RequestHostLive } from "./request.ts";
import {
  EventBus,
  ManifestRecorder,
  RequestClients,
  ScriptRunner,
  Settings,
} from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";

export interface ScriptProps {
  readonly id: string;
  /** Alchemy platform marker; scripts are always Effect-native. */
  readonly isExternal?: boolean;
  readonly env?: Record<string, unknown>;
  readonly exports?: string[] | Record<string, unknown>;
}

export interface ScriptAttributes {
  readonly startedAt?: string;
}

export interface ScriptResource extends Resource<"Ballast.Script", ScriptProps, ScriptAttributes, never, never> {}

export interface ScriptRuntimeContext extends BaseRuntimeContext {
  readonly phase: Phase;
  readonly run: (effect: Effect.Effect<void, never, never>) => Effect.Effect<void>;
}

/**
 * The services a script's init may use without the caller providing a layer.
 * Plan mode provides `ManifestRecorder`; runtime mode provides `EventBus`,
 * `Settings` and `RequestClients`.
 */
export type ScriptHostServices =
  | import("./topic.ts").EventHost
  | import("./request.ts").RequestHost
  | ScriptRunner
  | ScriptPhase
  | ManifestRecorder
  | Settings
  | EventBus
  | RequestClients;

const detectPhase = (): Phase =>
  globalThis.__ALCHEMY_RUNTIME__ || process.env["ALCHEMY_PHASE"] === "runtime" ? "runtime" : "plan";

const makeScriptRuntimeContext = (id: string): ScriptRuntimeContext => {
  const runners: Effect.Effect<void, never, never>[] = [];
  const env: Record<string, unknown> = {};
  const phase = detectPhase();

  return {
    Type: "Ballast.Script",
    id,
    phase,
    env,
    get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(process.env[key])),
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        const canonical = key.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[canonical] = output.pipe(OutputModule.map(packEnvValue));
        return canonical;
      }),
    run: (effect) =>
      Effect.sync(() => {
        runners.push(effect);
      }),
    exports: Effect.sync(() => ({
      program: Effect.all(runners, { concurrency: "unbounded" }),
    })),
    hostServices: Layer.mergeAll(
      Layer.succeed(ScriptRunner, {
        run: (effect) =>
          Effect.sync(() => {
            runners.push(effect);
          }),
      }),
      EventHostLive,
      RequestHostLive,
    ),
  };
};

const recorderFor = (
  method: (recorder: ManifestRecorderService) => Effect.Effect<void>,
  phase: Phase,
): Effect.Effect<void> => {
  if (phase !== "plan") return Effect.void;
  return Effect.serviceOption(ManifestRecorder).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(new Error("Script was evaluated in plan phase without a ManifestRecorder")),
        onSome: method,
      }),
    ),
  );
};

type ScriptPlatform = Platform<
  ScriptResource,
  ScriptHostServices,
  void,
  ScriptRuntimeContext,
  void
>;

const scriptPlatform: ScriptPlatform = Platform("Ballast.Script", {
  createRuntimeContext: makeScriptRuntimeContext,
  onCreate: (resource) =>
    Effect.gen(function* () {
      const phase = yield* currentPhase;
      yield* recorderFor((recorder) => recorder.script(resource.LogicalId), phase);
    }),
});

/**
 * Define a Ballast script. `init` only declares: params, connections, request
 * capabilities and topic subscriptions. Anything with effects belongs in a
 * handler or `Ballast.run`.
 */
export const Script = <R extends ScriptHostServices>(
  id: string,
  init: Effect.Effect<void, never, R>,
) => scriptPlatform(id, { id }, init);

/** Register a long-running loop. Runs when the host evaluates `exports.program`. */
export const run = (effect: Effect.Effect<void, never, never>): Effect.Effect<void, never, ScriptRunner> =>
  Effect.flatMap(ScriptRunner, (runner) => runner.run(effect));

