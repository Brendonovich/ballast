import * as Effect from "effect/Effect";
import { ManifestRecorder } from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";
import { ScriptPhase } from "./phase.ts";

/**
 * Provide the services a script needs to run its init in plan phase: the
 * manifest recorder the plan host layers write declarations to, and the phase
 * that selects those layers. No I/O is possible; request clients die if called.
 */
export const providePlan = <A, E>(
  effect: Effect.Effect<A, E, never>,
  recorder: ManifestRecorderService,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provideService(ManifestRecorder, ManifestRecorder.of(recorder)),
    Effect.provideService(ScriptPhase, "plan"),
  );
