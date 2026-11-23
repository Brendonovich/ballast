import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { currentPhase } from "./phase.ts";
import { captureSource } from "./source.ts";
import { ManifestRecorder } from "./services.ts";

export interface ArtifactOptions {
  readonly title?: string;
  readonly description?: string;
  /** Project-relative browser entry, for example "./artifacts/dashboard/main.tsx". */
  readonly entry: string;
}

export class ArtifactDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDeclarationError";
  }
}

const validate = (name: string, entry: string): void => {
  if (name.trim().length === 0) {
    throw new ArtifactDeclarationError("Artifact names must be non-empty");
  }
  if (entry.trim().length === 0) {
    throw new ArtifactDeclarationError(`Artifact "${name}" entry must be non-empty`);
  }
};

/**
 * Declare a browser artifact. Plan records its name, entry and source; the
 * planner builds it and the service hosts it. Runtime is a no-op: the manifest
 * already told the host everything it needs.
 */
export const Artifact = (
  name: string,
  options: ArtifactOptions,
): Effect.Effect<void> => {
  validate(name, options.entry);
  const source = captureSource(2);
  return Effect.gen(function* () {
    const phase = yield* currentPhase;
    if (phase !== "plan") return;
    const recorder = yield* Effect.serviceOption(ManifestRecorder);
    yield* Option.match(recorder, {
      onNone: () =>
        Effect.die(
          new Error(`Artifact "${name}" was declared in plan without a ManifestRecorder`),
        ),
      onSome: (service) =>
        service.artifact({
          name,
          entry: options.entry,
          ...(source === undefined ? {} : { source }),
          ...(options.title === undefined ? {} : { title: options.title }),
          ...(options.description === undefined ? {} : { description: options.description }),
        }),
    });
  });
};
