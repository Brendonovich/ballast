import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ManifestSchema, emptyManifest, evaluateScript, providePlan, type Manifest } from "@ballast/core";
import { bundlePlanScript } from "./bundle.ts";
import { makeManifestRecorder, normalizeManifest } from "./recorder.ts";
import { mapManifestSources } from "./source-map.ts";

export class PlanError extends Data.TaggedError("PlanError")<{
  readonly message: string;
}> {}

export interface PlanOptions {
  /** Project-relative script id. Defaults to the path relative to cwd. */
  readonly scriptId?: string;
  /** Directory whose node_modules are the fallback for bare imports. */
  readonly resolveDir?: string;
  /** Project root used to make source links project-relative. */
  readonly projectRoot?: string;
}

export interface PlannedScript {
  readonly manifest: Manifest;
  /** The optional `export const title`; otherwise the humanised file name. */
  readonly title: string;
}

const titleCase = (value: string): string =>
  value
    .split(/[-_.]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || value;

const defaultScriptId = (absoluteEntry: string): string => {
  const relativePath = relative(process.cwd(), absoluteEntry);
  const path =
    relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)
      ? basename(absoluteEntry)
      : relativePath;
  return path.split("\\").join("/").replace(/\.(?:[cm]?[jt]s)$/, "");
};

const titleFromId = (scriptId: string): string => {
  const file = scriptId.split("/").at(-1) ?? scriptId;
  const base = file.replace(/\.(?:[cm]?[jt]sx?)$/i, "");
  return titleCase(base);
};

const isScriptEffect = (value: unknown): value is Effect.Effect<unknown, unknown, never> =>
  Effect.isEffect(value);

/**
 * Evaluate one script's default export with plan services and return the
 * manifest plus the display title. Exported for tests; use `plan` for a
 * manifest or `planDetails` for both.
 */
export const runPlanInfo = (
  entry: string,
  options: PlanOptions = {},
): Effect.Effect<PlannedScript, PlanError> =>
  Effect.gen(function* () {
    const absoluteEntry = resolve(entry);
    const bundle = yield* Effect.tryPromise({
      try: () => bundlePlanScript(absoluteEntry, options.resolveDir),
      catch: (cause) =>
        new PlanError({
          message: `Failed to bundle ${absoluteEntry}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });

    const moduleExports: Record<string, unknown> = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(bundle.path).href + `?t=${Date.now()}`),
      catch: (cause) =>
        new PlanError({
          message: `Failed to import plan bundle for ${absoluteEntry}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });

    const script = moduleExports["default"];
    if (!isScriptEffect(script)) {
      return yield* Effect.fail(
        new PlanError({
          message: `${absoluteEntry} must default-export an Effect (a Ballast script)`,
        }),
      );
    }

    const scriptId = options.scriptId ?? defaultScriptId(absoluteEntry);
    const exportedTitle = moduleExports["title"];
    const title =
      typeof exportedTitle === "string" && exportedTitle.trim().length > 0
        ? exportedTitle
        : titleFromId(scriptId);
    const ref = yield* Ref.make(emptyManifest(scriptId));
    const recorder = makeManifestRecorder(ref);

    const exit = yield* providePlan(evaluateScript(Effect.asVoid(script), "plan"), recorder).pipe(
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      return yield* Effect.fail(new PlanError({ message: Cause.pretty(exit.cause) }));
    }

    const manifest = yield* Ref.get(ref);
    const normalized = normalizeManifest(manifest);
    const projectRoot =
      options.projectRoot ??
      (basename(absoluteEntry) === "ballast.ts"
        ? dirname(absoluteEntry)
        : undefined);
    const mapped =
      projectRoot === undefined || bundle.sourceMap === undefined
        ? stripSources(normalized)
        : mapManifestSources(
            normalized,
            bundle.sourceMap,
            bundle.path,
            projectRoot,
          );
    assertUniqueNames(mapped);
    return { manifest: mapped, title };
  });

/** The manifest-only planner used by the CLI and tests. */
export const runPlan = (
  entry: string,
  options: PlanOptions = {},
): Effect.Effect<Manifest, PlanError> =>
  runPlanInfo(entry, options).pipe(Effect.map((result) => result.manifest));

/**
 * Validate a manifest loaded from disk (the CLI's `--diff` input).
 */
const stripSources = (manifest: Manifest): Manifest => ({
  ...manifest,
  params: manifest.params.map(({ source: _source, ...param }) => param),
  topics: manifest.topics.map(({ source: _source, ...topic }) => topic),
  timers: manifest.timers.map(({ source: _source, ...timer }) => timer),
  workflows: manifest.workflows.map(({ source: _source, ...workflow }) => workflow),
  runs: manifest.runs.map(({ source: _source, ...run }) => run),
});

const assertUniqueNames = (manifest: Manifest): void => {
  const formatSource = (source: Manifest["topics"][number]["source"]): string =>
    source === undefined
      ? "<unknown source>"
      : `${source.file}:${source.line}:${source.column}`;
  const topics = new Map<string, string>();
  for (const topic of manifest.topics) {
    const previous = topics.get(topic.name);
    if (previous !== undefined) {
      throw new PlanError({
        message: `Duplicate subscription name "${topic.name}" at ${previous} and ${formatSource(topic.source)}`,
      });
    }
    topics.set(topic.name, formatSource(topic.source));
  }

  const assertUnique = (
    kind: string,
    units: ReadonlyArray<{ readonly name: string; readonly source?: Manifest["topics"][number]["source"] }>,
  ): void => {
    const seen = new Map<string, string>();
    for (const unit of units) {
      const previous = seen.get(unit.name);
      if (previous !== undefined) {
        throw new PlanError({
          message: `Duplicate ${kind} name "${unit.name}" at ${previous} and ${formatSource(unit.source)}`,
        });
      }
      seen.set(unit.name, formatSource(unit.source));
    }
  };
  assertUnique(
    "param",
    manifest.params.map((value) => ({ name: value.key, ...(value.source === undefined ? {} : { source: value.source }) })),
  );
  assertUnique(
    "timer",
    manifest.timers.map((value) => ({ name: value.name, ...(value.source === undefined ? {} : { source: value.source }) })),
  );
  assertUnique(
    "workflow",
    manifest.workflows.map((value) => ({ name: value.name, ...(value.source === undefined ? {} : { source: value.source }) })),
  );
  assertUnique(
    "run",
    manifest.runs.map((value) => ({ name: value.name, ...(value.source === undefined ? {} : { source: value.source }) })),
  );
};

export const decodeManifest = (input: unknown): Manifest =>
  Schema.decodeUnknownSync(ManifestSchema)(input);
