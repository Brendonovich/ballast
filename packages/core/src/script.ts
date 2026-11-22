import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { currentPhase, ScriptPhase } from "./phase.ts";
import type { Phase } from "./phase.ts";
import { RequestHostPlan, RequestHostRuntime } from "./request.ts";
import type { RequestHost } from "./request.ts";
import { EventHostPlan, EventHostRuntime } from "./topic.ts";
import type { EventHost } from "./topic.ts";
import { ManifestRecorder, ScriptRunner } from "./services.ts";
import type { EventBus, RequestClients, ScriptRunnerService, Settings } from "./services.ts";

export interface ScriptRuntimeContext {
  readonly phase: Phase;
  readonly run: (effect: Effect.Effect<void, never, never>) => Effect.Effect<void>;
  /** Long-running loops registered with `Ballast.run`, plus host exports. */
  readonly exports: Effect.Effect<Record<string, unknown>>;
}

/**
 * The services a script's init may use. The host provides them around the
 * default export; scripts never construct the phase layers themselves.
 */
export type ScriptHostServices =
  | EventHost
  | RequestHost
  | ScriptRunner
  | ScriptPhase
  | ManifestRecorder
  | Settings
  | EventBus
  | RequestClients;

/** Everything the host provides around the default export. */
type ScriptProvidedServices = EventHost | RequestHost | ScriptRunner | ScriptPhase;

/**
 * The optional type a script can use for checking:
 *
 * ```ts
 * export default Effect.gen(function* () { ... }) satisfies Ballast.Script;
 * ```
 */
export type Script<E = never> = Effect.Effect<void, E, ScriptHostServices>;

interface ScriptRunnerState {
  readonly service: ScriptRunnerService;
  readonly exports: Effect.Effect<Record<string, unknown>>;
}

/**
 * Collect the loops a script registers with `Ballast.run`. Plan never evaluates
 * `exports`; the runtime worker does, once init has declared everything.
 */
const makeScriptRunner = (): ScriptRunnerState => {
  const loops: Effect.Effect<void, never, never>[] = [];

  return {
    service: {
      run: (effect) =>
        Effect.sync(() => {
          loops.push(effect);
        }),
    },
    exports: Effect.sync(() => ({
      program: Effect.all(loops, { concurrency: "unbounded" }),
    })),
  };
};

const planHostServices = (
  runner: ScriptRunnerService,
  phase: Phase,
): Layer.Layer<ScriptProvidedServices> =>
  Layer.mergeAll(
    Layer.succeed(ScriptRunner, runner),
    Layer.succeed(ScriptPhase, phase),
    EventHostPlan,
    RequestHostPlan,
  );

const runtimeHostServices = (
  runner: ScriptRunnerService,
  phase: Phase,
): Layer.Layer<ScriptProvidedServices> =>
  Layer.mergeAll(
    Layer.succeed(ScriptRunner, runner),
    Layer.succeed(ScriptPhase, phase),
    EventHostRuntime,
    RequestHostRuntime,
  );

export interface ScriptRuntime {
  readonly run: ScriptRunnerService["run"];
  /** Long-running loops registered with `Ballast.run`. */
  readonly exports: Effect.Effect<Record<string, unknown>>;
}

/**
 * Evaluate a script's default export in one phase. The planner calls this with
 * `"plan"`, the runtime worker with `"runtime"`; both provide the host
 * services and never leak a per-event scope into init. The caller provides the
 * manifest recorder (plan) or settings/event bus/request clients (runtime).
 */
export const evaluateScript = <E, R extends ScriptHostServices>(
  script: Effect.Effect<void, E, R>,
  phase: Phase,
): Effect.Effect<ScriptRuntime, E, Exclude<R, ScriptProvidedServices>> =>
  Effect.gen(function* () {
    const runner = makeScriptRunner();
    yield* script.pipe(
      Effect.provide(
        phase === "plan"
          ? planHostServices(runner.service, phase)
          : runtimeHostServices(runner.service, phase),
      ),
    );
    return {
      run: runner.service.run,
      exports: runner.exports,
    };
  });

/** Register a long-running loop. Runs when the host evaluates `exports.program`. */
export const run = (effect: Effect.Effect<void, never, never>): Effect.Effect<void, never, ScriptRunner> =>
  Effect.flatMap(ScriptRunner, (runner) => runner.run(effect));

/** The phase the current script is evaluated in. */
export const phase: Effect.Effect<Phase> = currentPhase;

/** Record the script id when a caller has one (the planner fills it from the path). */
export const recordScriptId = (id: string): Effect.Effect<void> =>
  Effect.serviceOption(ManifestRecorder).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (recorder) => recorder.script(id),
      }),
    ),
  );
