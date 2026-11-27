import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { currentPhase } from "./phase.ts";
import { ManifestRecorder } from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";
import { captureSource } from "./source.ts";

export interface ArtifactOptions {
  readonly title?: string;
  readonly description?: string;
  /** Project-relative browser entry, for example "./artifacts/dashboard/main.tsx". */
  readonly entry: string;
  /** Prefer a transparent page background (OBS browser source overlays). */
  readonly transparent?: boolean;
}

/**
 * The stable artifact origin and capability the host folds into plan/runtime
 * bundles. It is a build-time constant, so init can build a URL without I/O.
 * The token is a per-project capability; artifacts are private to the project.
 */
export interface ArtifactHost {
  /** For example "http://127.0.0.1:47831". */
  readonly origin: string;
  readonly stableToken: string;
}

declare global {
  var __BALLAST_ARTIFACT_HOST__: ArtifactHost | undefined;
}

/**
 * A declared artifact. `url` is always a string so it can be passed straight
 * to a schema-typed declaration such as a Sceneify browser source.
 *
 * - With an artifact host (the Ballast service), it is the stable page URL,
 *   and survives service restarts.
 * - During standalone `ballast plan`, it is a clearly marked placeholder and
 *   the first read records a manifest `unresolved` entry.
 * - During standalone `ballast run`, reading it throws
 *   `ArtifactUrlUnavailableError`.
 */
export interface ArtifactHandle {
  readonly name: string;
  readonly title?: string;
  readonly url: string;
  readonly transparent: boolean;
}

export class ArtifactDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDeclarationError";
  }
}

/** No artifact gateway was available when the artifact URL was read at runtime. */
export class ArtifactUrlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUrlUnavailableError";
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
 * The gateway path is /a/<token>/<artifact>/index.html. Kept identical in
 * @ballast/artifact so a page can read its own token from the path.
 */
export const artifactPageUrl = (
  host: ArtifactHost,
  artifact: string,
  transparent: boolean,
): string =>
  host.origin +
  "/a/" +
  encodeURIComponent(host.stableToken) +
  "/" +
  encodeURIComponent(artifact) +
  "/index.html" +
  (transparent ? "?background=transparent" : "");

/**
 * A stand-in for plan output when no gateway is running. It must be obviously
 * unusable so a copied value cannot be mistaken for a working OBS URL; reading
 * it also records an `unresolved` manifest entry.
 */
export const unresolvedArtifactUrl = (artifact: string, transparent: boolean): string =>
  "http://127.0.0.1:0/unresolved/artifacts/" +
  encodeURIComponent(artifact) +
  "/index.html" +
  (transparent ? "?background=transparent" : "");

const unavailableMessage = (name: string): string =>
  `Artifact "${name}" has no URL. Artifact URLs are injected by the Ballast service, so start the project through the Ballast app/service instead of standalone "ballast run", and keep BALLAST_ARTIFACT_PORT at a stable port.`;

/**
 * Declare a browser artifact. Plan records its name, entry and source; the
 * planner builds it and the service hosts it. The returned handle exposes
 * `url` as a plain string so init can pass it straight to another declaration
 * (for example an OBS browser source) without I/O.
 *
 * The URL comes from the bundle constant the service folds in. When no host is
 * available, plan returns a placeholder and records an unresolved entry the
 * first time `url` is read; runtime throws instead of handing OBS a broken
 * page.
 */
export const Artifact = (
  name: string,
  options: ArtifactOptions,
): Effect.Effect<ArtifactHandle> => {
  validate(name, options.entry);
  const source = captureSource(2);
  const transparent = options.transparent === true;
  return Effect.gen(function* () {
    const phase = yield* currentPhase;
    let recorder: ManifestRecorderService | undefined;
    if (phase === "plan") {
      const service = yield* Effect.serviceOption(ManifestRecorder);
      recorder = Option.getOrUndefined(service);
      yield* Option.match(service, {
        onNone: () =>
          Effect.die(
            new Error(`Artifact "${name}" was declared in plan without a ManifestRecorder`),
          ),
        onSome: (value) =>
          value.artifact({
            name,
            entry: options.entry,
            ...(source === undefined ? {} : { source }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.description === undefined ? {} : { description: options.description }),
          }),
      });
    }
    const host = globalThis.__BALLAST_ARTIFACT_HOST__;
    const resolved = host === undefined ? undefined : artifactPageUrl(host, name, transparent);
    let reported = false;
    return {
      name,
      ...(options.title === undefined ? {} : { title: options.title }),
      transparent,
      get url(): string {
        if (resolved !== undefined) return resolved;
        if (phase === "runtime") {
          throw new ArtifactUrlUnavailableError(unavailableMessage(name));
        }
        if (!reported) {
          reported = true;
          if (recorder !== undefined) {
            Effect.runSync(
              recorder.unresolved({
                path: "artifact:" + name,
                reason:
                  `Artifact "${name}" has no URL while planning, so its .url is the placeholder ${unresolvedArtifactUrl(name, transparent)}. Run the project through the Ballast service, which injects the stable artifact URL.`,
              }),
            );
          }
        }
        return unresolvedArtifactUrl(name, transparent);
      },
    };
  });
};
