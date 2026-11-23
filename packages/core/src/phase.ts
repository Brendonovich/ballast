import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

declare global {
  /**
   * Folded to `"runtime"` by the runtime bundler. Source runs (the planner and
   * tests) leave it undefined, which means plan phase. The host normally
   * provides `ScriptPhase` explicitly; this is the default for code that is
   * evaluated without a host, and it lets a bundler drop plan-only branches.
   */
  var __BALLAST_PHASE__: Phase | undefined;
}

export type Phase = "plan" | "runtime";

const defaultPhase: Effect.Effect<Phase> = Effect.gen(function* () {
  const configured = yield* Config.String("BALLAST_PHASE").pipe(
    Config.option,
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  return globalThis.__BALLAST_PHASE__ === "runtime" || Option.contains(configured, "runtime")
    ? "runtime"
    : "plan";
});

/**
 * The phase the current script is evaluated in. The planner provides
 * `"plan"`; the runtime worker provides `"runtime"`. The fallback keeps
 * unbundled direct runs (and tests) in plan phase.
 */
export class ScriptPhase extends Context.Service<ScriptPhase, Phase>()("Ballast/ScriptPhase") {}

export const currentPhase: Effect.Effect<Phase> = Effect.serviceOption(ScriptPhase).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => defaultPhase,
      onSome: (phase) => Effect.succeed(phase),
    }),
  ),
);
