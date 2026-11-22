import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

declare global {
  /**
   * Folded to `true` by the runtime bundler. When running source directly it is
   * `undefined`, which means plan phase.
   */
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}

export type Phase = "plan" | "runtime";

/**
 * The phase the current script is evaluated in. The planner provides
 * `"plan"`; the runtime worker provides `"runtime"`. The fallback keeps
 * unbundled direct runs (and tests) in plan phase.
 */
export class ScriptPhase extends Context.Service<ScriptPhase, Phase>()("Ballast/ScriptPhase") {}

export const currentPhase: Effect.Effect<Phase> = Effect.serviceOption(ScriptPhase).pipe(
  Effect.map(
    Option.getOrElse(
      (): Phase =>
        globalThis.__ALCHEMY_RUNTIME__ || process.env["ALCHEMY_PHASE"] === "runtime"
          ? "runtime"
          : "plan",
    ),
  ),
);
