import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ManifestSchema, emptyManifest, providePlan, type Manifest } from "@ballast/core";
import { makeManifestRecorder, normalizeManifest } from "./recorder.ts";

export class PlanError extends Data.TaggedError("PlanError")<{
  readonly message: string;
}> {}

const scriptIdFromEntry = (entry: string): string =>
  basename(entry).replace(/\.(?:[cm]?[jt]s)$/, "");

const isScriptEffect = (value: unknown): value is Effect.Effect<unknown, unknown, never> =>
  Effect.isEffect(value);

const isScriptInstance = (value: unknown): value is { readonly Type: "Ballast.Script" } =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === "Ballast.Script";

/**
 * Evaluate one script's init in the current process with plan services.
 * Exported for the plan worker and for tests; call `plan` to get isolation.
 */
export const runPlan = (entry: string): Effect.Effect<Manifest, PlanError> =>
  Effect.gen(function* () {
    const absoluteEntry = resolve(entry);

    const moduleExports: Record<string, unknown> = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(absoluteEntry).href),
      catch: (cause) =>
        new PlanError({
          message: `Failed to import ${absoluteEntry}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    const script = moduleExports["default"];
    if (!isScriptEffect(script)) {
      return yield* Effect.fail(
        new PlanError({
          message: `${absoluteEntry} must default-export Ballast.Script(...) (an Effect)`,
        }),
      );
    }

    const ref = yield* Ref.make(emptyManifest(scriptIdFromEntry(absoluteEntry)));
    const recorder = makeManifestRecorder(ref);

    const exit = yield* providePlan(script, recorder).pipe(Effect.exit);

    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(new PlanError({ message: Cause.pretty(exit.cause) }));
    }

    if (!isScriptInstance(exit.value)) {
      return yield* Effect.fail(
        new PlanError({ message: `${absoluteEntry} did not evaluate to a Ballast.Script` }),
      );
    }

    const manifest = yield* Ref.get(ref);
    return normalizeManifest(manifest);
  });

/**
 * Validate a manifest loaded from disk (the CLI's `--diff` input).
 */
export const decodeManifest = (input: unknown): Manifest =>
  Schema.decodeUnknownSync(ManifestSchema)(input);
