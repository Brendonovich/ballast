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
import { TimerHost, TimerHostPlan, TimerHostRuntime } from "./timer.ts";
import { captureSource } from "./source.ts";
import { withUnit } from "./unit.ts";

export interface ScriptRuntimeContext {
  readonly phase: Phase;
  readonly run: (
    name: string,
    effect: Effect.Effect<void, never, never>,
  ) => Effect.Effect<void>;
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
  | RequestClients
  | TimerHost;

/** Everything the host provides around the default export. */
type ScriptProvidedServices =
  | EventHost
  | RequestHost
  | ScriptRunner
  | ScriptPhase
  | TimerHost;

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
  const loops: Array<{
    readonly name: string;
    readonly effect: Effect.Effect<void, never, never>;
  }> = [];

  return {
    service: {
      run: (name, effect) =>
        Effect.sync(() => {
          loops.push({ name, effect });
        }),
    },
    exports: Effect.sync(() => ({
      program: Effect.all(
        loops.map((loop) => withUnit(loop.name, loop.effect)),
        { concurrency: "unbounded" },
      ),
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
    TimerHostPlan,
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
    TimerHostRuntime,
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

/**
 * Register a long-running, non-durable loop. Runs when the host evaluates
 * `exports.program`. A loop that must survive a restart belongs in a workflow.
 */
export const run = (
  name: string,
  effect: Effect.Effect<void, never, never>,
): Effect.Effect<void, never, ScriptRunner> => {
  const source = captureSource(2);
  return Effect.gen(function* () {
    const phase = yield* currentPhase;
    if (phase === "plan") {
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      if (Option.isSome(recorder)) {
        yield* recorder.value.run({
          name,
          ...(source === undefined ? {} : { source }),
        });
      }
      return;
    }
    const runner = yield* ScriptRunner;
    yield* runner.run(name, effect);
  });
};

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
