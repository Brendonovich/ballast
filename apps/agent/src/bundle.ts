import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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

const requireFromHere = createRequire(fileURLToPath(import.meta.url));

/**
 * Resolve bare imports with Node's own resolver from the importer, falling
 * back to the agent's dependencies. This lets a script copied to a temp folder
 * without a node_modules directory bundle against the workspace packages.
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
): Effect.Effect<RuntimeBundle, BundleError> =>
  Effect.tryPromise({
    try: async () => {
      const absoluteEntry = resolve(entry);
      const coreEntry = fileURLToPath(import.meta.resolve("@ballast/core"));
      const directory = await mkdtemp(join(tmpdir(), "ballast-runtime-"));
      const input = join(directory, "entry.ts");
      const output = join(directory, "script.mjs");

      const source = [
        `import { runRuntimeWorker } from ${JSON.stringify(coreEntry)};`,
        `import script from ${JSON.stringify(absoluteEntry)};`,
        `runRuntimeWorker(script).catch((error) => {`,
        `  console.error("[runtime] failed to start", error);`,
        `  process.exit(1);`,
        `});`,
      ].join("\n");
      await writeFile(input, `${source}\n`, "utf8");

      const bundle = await rolldown({
        input,
        platform: "node",
        plugins: [nodeResolvePlugin],
        transform: {
          define: {
            "globalThis.__ALCHEMY_RUNTIME__": "true",
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
      });

      try {
        const result = await bundle.generate({
          format: "esm",
          minify: "dce-only",
          codeSplitting: false,
        });
        const chunk = result.output.find((item) => item.type === "chunk");
        if (chunk === undefined) {
          throw new Error("Rolldown produced no JavaScript chunk");
        }
        await writeFile(output, chunk.code, "utf8");
        return {
          generation,
          path: output,
          directory,
          bytes: chunk.code.length,
        };
      } finally {
        await bundle.close();
      }
    },
    catch: (cause) =>
      new BundleError({
        message: `Failed to bundle ${entry}: ${
          cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
        }`,
      }),
  });
