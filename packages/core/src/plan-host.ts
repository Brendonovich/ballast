import { Stage } from "alchemy/Stage";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { ManifestRecorder } from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";
import { ScriptPhase } from "./phase.ts";

const planStack = {
  name: "Ballast",
  stage: "local",
  resources: {},
  bindings: {},
  actions: {},
};

/**
 * Provide the services a script needs to run its init in plan phase. Alchemy's
 * `Platform` still needs a `Stack` and `Stage` value even though Ballast does
 * not plan/apply through Alchemy; they are constant here.
 *
 * Kept in `@ballast/core` so neither the planner nor scripts import `alchemy`.
 */
export const providePlan = <A, E>(
  effect: Effect.Effect<A, E, never>,
  recorder: ManifestRecorderService,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provideService(ManifestRecorder, ManifestRecorder.of(recorder)),
    Effect.provideService(ScriptPhase, "plan"),
    Effect.provideService(Stack, planStack),
    Effect.provideService(Stage, "local"),
    Effect.scoped,
  );
