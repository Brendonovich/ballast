import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";

const requireFromHere = createRequire(fileURLToPath(import.meta.url));

const resolver = (resolveDir: string | undefined): Plugin => {
  const fallback =
    resolveDir === undefined
      ? requireFromHere
      : createRequire(join(resolve(resolveDir), "package.json"));
  return {
    name: "ballast-plan-resolve",
    resolveId(source, importer) {
      if (source.startsWith("node:") || isBuiltin(source)) {
        return { id: source, external: true };
      }
      if (source.startsWith(".") || source.startsWith("/")) return null;
      if (importer !== undefined) {
        try {
          return createRequire(importer).resolve(source);
        } catch {
          // Fall through to the host's dependencies.
        }
      }
      try {
        return fallback.resolve(source);
      } catch {
        try {
          return requireFromHere.resolve(source);
        } catch {
          return null;
        }
      }
    },
  };
};

export interface BundledPlanScript {
  readonly path: string;
  readonly directory: string;
  readonly title: string | undefined;
}

/**
 * Bundle one script for planning. Planning must resolve bare imports the same
 * way the runtime bundle does, so a project outside the repo can be planned
 * without its own node_modules; `resolveDir` points at the agent/stage whose
 * dependencies are the fallback (the planner's own dependencies otherwise).
 */
export const bundlePlanScript = async (
  entry: string,
  resolveDir: string | undefined,
): Promise<BundledPlanScript> => {
  const absoluteEntry = resolve(entry);
  const directory = await mkdtemp(join(tmpdir(), "ballast-plan-"));
  const input = join(directory, "entry.ts");
  const output = join(directory, "script.mjs");
  const source = [
    `import * as scriptModule from ${JSON.stringify(absoluteEntry)};`,
    `export const title = scriptModule.title;`,
    `export default scriptModule.default;`,
  ].join("\n");
  await writeFile(input, `${source}\n`, "utf8");

  const bundle = await rolldown({
    input,
    platform: "node",
    plugins: [resolver(resolveDir)],
    transform: {
      define: {
        "globalThis.__BALLAST_PHASE__": JSON.stringify("plan"),
      },
    },
    onwarn(warning) {
      if (warning.code === "UNRESOLVED_IMPORT") {
        console.warn(`[plan] ${warning.message}`);
      }
    },
  });
  try {
    const result = await bundle.generate({
      format: "esm",
      codeSplitting: false,
      minify: false,
    });
    const chunk = result.output.find((item) => item.type === "chunk");
    if (chunk === undefined) throw new Error("Rolldown produced no plan bundle");
    await writeFile(output, chunk.code, "utf8");
  } finally {
    await bundle.close();
  }

  const moduleExports: Record<string, unknown> = await import(
    pathToFileURL(output).href + `?t=${Date.now()}`
  );
  const title = moduleExports["title"];
  return {
    path: output,
    directory,
    title: typeof title === "string" && title.trim().length > 0 ? title : undefined,
  };
};
