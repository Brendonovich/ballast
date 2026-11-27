import { createRequire, isBuiltin } from "node:module";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ArtifactHost } from "@ballast/core";
import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
}> {}

export interface RuntimeBundle {
  readonly generation: number;
  readonly path: string;
  readonly directory: string;
  readonly bytes: number;
}

const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve bare imports with Node's own resolver from the importer, falling
 * back to the agent's dependencies. This lets a script copied to a temp folder
 * without a node_modules directory bundle against the workspace packages.
 * Module resolution is a Node loader concern; Effect does not wrap it.
 */
const nodeResolvePlugin: Plugin = {
  name: "ballast-node-resolve",
  resolveId(source, importer) {
    if (source.startsWith("node:") || isBuiltin(source)) {
      return { id: source, external: true };
    }
    if (source.startsWith(".") || source.startsWith("/")) {
      return null;
    }
    if (importer !== undefined) {
      try {
        return createRequire(importer).resolve(source);
      } catch {
        // Fall through to the agent's dependencies below.
      }
    }
    try {
      return requireFromHere.resolve(source);
    } catch {
      return null;
    }
  },
};

/**
 * Bundle the script plus the runtime worker bootstrap into one ESM file. The
 * runtime define folds plan-only branches and Alchemy's plan/apply code.
 */
export const bundleScript = (
  entry: string,
  generation: number,
  artifactHost?: ArtifactHost,
): Effect.Effect<
  RuntimeBundle,
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absoluteEntry = path.resolve(entry);
    const coreEntry = yield* path
      .fromFileUrl(new URL(import.meta.resolve("@ballast/core")))
      .pipe(
        Effect.mapError(
          (cause) =>
            new BundleError({ message: `Could not resolve @ballast/core: ${cause.message}` }),
        ),
      );
    const directory = yield* fs
      .makeTempDirectory({ prefix: "ballast-runtime-" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BundleError({ message: `Could not create a bundle directory: ${cause.message}` }),
        ),
      );
    const input = path.join(directory, "entry.ts");
    const output = path.join(directory, "script.mjs");

    const source = [
      `import { runRuntimeWorker } from ${JSON.stringify(coreEntry)};`,
      `import script from ${JSON.stringify(absoluteEntry)};`,
      `runRuntimeWorker(script).catch((error) => {`,
      `  console.error("[runtime] failed to start", error);`,
      `  process.exit(1);`,
      `});`,
    ].join("\n");
    yield* fs.writeFileString(input, `${source}\n`).pipe(Effect.orDie);

    const run = Effect.tryPromise({
      try: () =>
        rolldown({
          input,
          platform: "node",
          plugins: [nodeResolvePlugin],
          transform: {
            define: {
              "globalThis.__BALLAST_PHASE__": JSON.stringify("runtime"),
              ...(artifactHost === undefined
                ? {}
                : { "globalThis.__BALLAST_ARTIFACT_HOST__": JSON.stringify(artifactHost) }),
            },
          },
          onwarn(warning) {
            if (
              warning.code === "UNRESOLVED_IMPORT" &&
              warning.message.includes("@effect/platform-bun")
            ) {
              // Alchemy's Bun-only branches are never taken in the Node worker.
              return;
            }
            console.warn(`[bundle] ${warning.message}`);
          },
        }),
      catch: (cause) =>
        new BundleError({
          message: `Failed to bundle ${entry}: ${
            cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
          }`,
        }),
    });

    const bundle = yield* run;
    const result = yield* Effect.tryPromise({
      try: () =>
        bundle.generate({
          format: "esm",
          minify: "dce-only",
          codeSplitting: false,
        }),
      catch: (cause) =>
        new BundleError({
          message: `Failed to bundle ${entry}: ${
            cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
          }`,
        }),
    }).pipe(Effect.ensuring(Effect.promise(() => bundle.close()).pipe(Effect.ignore)));
    const chunk = result.output.find((item) => item.type === "chunk");
    if (chunk === undefined) {
      return yield* Effect.fail(
        new BundleError({ message: "Rolldown produced no JavaScript chunk" }),
      );
    }
    yield* fs.writeFileString(output, chunk.code).pipe(Effect.orDie);
    return {
      generation,
      path: output,
      directory,
      bytes: chunk.code.length,
    };
  });
