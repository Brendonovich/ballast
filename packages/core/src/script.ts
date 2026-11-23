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
import { DatabaseHost, DatabaseHostPlan, DatabaseHostRuntime } from "./database.ts";
import { ApiHost, makeApiHostPlan, makeApiHostRuntime } from "./api.ts";
import type { ApiHostService, ApiStart } from "./api.ts";
import { provideRuntime, Runtime } from "./runtime.ts";
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
  | TimerHost
  | ApiHost
  | DatabaseHost;

/** Everything the host provides around the default export. */
type ScriptProvidedServices =
  | EventHost
  | RequestHost
  | ScriptRunner
  | ScriptPhase
  | TimerHost
  | ApiHost
  | DatabaseHost;

/**
 * The optional type a script can use for checking:
 *
 * ```ts
 * export default Effect.gen(function* () { ... }) satisfies Ballast.Script;
 * ```
 */
export type Script<E = never> = Effect.Effect<void, E, ScriptHostServices>;

/**
 * The type a project entry can `satisfies` so an editor rejects a param or
 * request read in init: such a read leaves `Ballast.Runtime` in the effect's
 * requirements, which this type does not include.
 */
export type Project<E = never> = Script<E>;

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
  api: ApiHostService,
): Layer.Layer<ScriptProvidedServices> =>
  Layer.mergeAll(
    Layer.succeed(ScriptRunner, runner),
    Layer.succeed(ScriptPhase, phase),
    Layer.succeed(ApiHost, api),
    EventHostPlan,
    RequestHostPlan,
    TimerHostPlan,
    DatabaseHostPlan,
  );

const runtimeHostServices = (
  runner: ScriptRunnerService,
  phase: Phase,
  api: ApiHostService,
): Layer.Layer<ScriptProvidedServices> =>
  Layer.mergeAll(
    Layer.succeed(ScriptRunner, runner),
    Layer.succeed(ScriptPhase, phase),
    Layer.succeed(ApiHost, api),
    EventHostRuntime,
    RequestHostRuntime,
    TimerHostRuntime,
    DatabaseHostRuntime,
  );

export interface ScriptRuntime {
  readonly run: ScriptRunnerService["run"];
  /** Long-running loops registered with `Ballast.run`. */
  readonly exports: Effect.Effect<Record<string, unknown>>;
  /** The artifact API server registered by `Api.serve`, if any. */
  readonly api: Effect.Effect<ApiStart | undefined>;
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
    const apiHost =
      phase === "plan"
        ? makeApiHostPlan(yield* Effect.serviceOption(ManifestRecorder))
        : makeApiHostRuntime();
    yield* script.pipe(
      Effect.provide(
        phase === "plan"
          ? planHostServices(runner.service, phase, apiHost)
          : runtimeHostServices(runner.service, phase, apiHost),
      ),
    );
    return {
      run: runner.service.run,
      exports: runner.exports,
      api: apiHost.current,
    };
  });

/**
 * Register a long-running, non-durable loop. Runs when the host evaluates
 * `exports.program`. A loop that must survive a restart belongs in a workflow.
 */
export const run = (
  name: string,
  effect: Effect.Effect<void, never, Runtime>,
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
    yield* runner.run(name, provideRuntime(effect));
  });
};

/** The phase the current script is evaluated in. */
export const phase: Effect.Effect<Phase> = currentPhase;

/** Record the project identity when a caller has one (the planner fills it in). */
export const recordProject = (project: {
  readonly id: string;
  readonly entry: string;
}): Effect.Effect<void> =>
  Effect.serviceOption(ManifestRecorder).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (recorder) => recorder.project(project),
      }),
    ),
  );
