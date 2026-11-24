import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import solid from "@solidjs/babel-plugin";
import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";
import type { ArtifactManifest } from "@ballast/core";
import { resolverPlugin } from "./bundle.ts";

export class ArtifactBundleError extends Error {
  readonly artifact: string;
  constructor(artifact: string, message: string) {
    super(`Artifact "${artifact}" failed to bundle: ${message}`);
    this.name = "ArtifactBundleError";
    this.artifact = artifact;
  }
}

export interface BuiltArtifact {
  readonly name: string;
  readonly entry: string;
  readonly directory: string;
  readonly htmlPath: string;
  readonly javascriptPath: string;
  readonly bytes: number;
}

const solidPlugin = (): Plugin => ({
  name: "ballast-solid-jsx",
  async transform(code, id) {
    if (!id.endsWith(".tsx") && !id.endsWith(".jsx")) return null;
    const result = await transformAsync(code, {
      filename: id,
      babelrc: false,
      configFile: false,
      sourceMaps: true,
      plugins: [[solid, { generate: "dom", hydratable: false, moduleName: "@solidjs/web" }]],
      parserOpts: { plugins: ["jsx", "typescript"] },
    });
    if (result?.code === null || result?.code === undefined) return null;
    return {
      code: result.code,
      map: result.map === null || result.map === undefined ? null : JSON.stringify(result.map),
    };
  },
});

const artifactDirectory = (root: string, name: string): string =>
  join(root, ".ballast", "artifacts", encodeURIComponent(name));

const html = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ballast artifact</title>
    <style>
      html, body, #root { margin: 0; min-height: 100%; background: transparent; }
      body { color: #e6edf7; font-family: ui-sans-serif, system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./bootstrap.js"></script>
  </body>
</html>
`;

/**
 * Kept in its own file because artifact pages run under a strict CSP with no
 * inline script. Same behaviour as the old inline module.
 */
const bootstrap = (): string => `import mount from "./main.js";
const root = document.getElementById("root") ?? document.body;
try {
  // createArtifact() mounts from module scope and returns a no-arg cleanup.
  // A legacy entry that still takes the root element is called with it.
  if (typeof mount === "function" && mount.length > 0) {
    const started = mount(root);
    if (started instanceof Promise) await started;
  }
} catch (cause) {
  console.error("Artifact mount failed", cause);
  root.textContent = "Artifact failed to start";
}
`;

const bundleOne = async (
  root: string,
  artifact: ArtifactManifest,
  resolveDir: string | undefined,
): Promise<BuiltArtifact> => {
  const absoluteEntry = resolve(root, artifact.entry);
  const inside = relative(root, absoluteEntry);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new ArtifactBundleError(artifact.name, "entry escapes the project root");
  }
  if (!existsSync(absoluteEntry)) {
    throw new ArtifactBundleError(artifact.name, "entry does not exist: " + artifact.entry);
  }
  const directory = artifactDirectory(root, artifact.name);
  await mkdir(directory, { recursive: true });
  const javascriptPath = join(directory, "main.js");
  const bootstrapPath = join(directory, "bootstrap.js");
  const htmlPath = join(directory, "index.html");

  const bundle = await rolldown({
    input: absoluteEntry,
    platform: "browser",
    plugins: [resolverPlugin(resolveDir, true), solidPlugin()],
  });
  try {
    const result = await bundle.generate({
      format: "esm",
      codeSplitting: false,
      minify: false,
      sourcemap: true,
    });
    const chunk = result.output.find((item) => item.type === "chunk");
    if (chunk === undefined) {
      throw new ArtifactBundleError(artifact.name, "rolldown produced no output");
    }
    const map = chunk.map;
    const sourceMap =
      map === null || map === undefined
        ? undefined
        : typeof map === "string"
          ? map
          : JSON.stringify(map);
    if (sourceMap !== undefined) {
      await writeFile(javascriptPath + ".map", sourceMap, "utf8");
      await writeFile(
        javascriptPath,
        chunk.code + "\n//# sourceMappingURL=main.js.map\n",
        "utf8",
      );
    } else {
      await writeFile(javascriptPath, chunk.code, "utf8");
    }
    await writeFile(bootstrapPath, bootstrap(), "utf8");
    await writeFile(htmlPath, html(), "utf8");
    return {
      name: artifact.name,
      entry: artifact.entry,
      directory,
      htmlPath,
      javascriptPath,
      bytes: Buffer.byteLength(chunk.code),
    };
  } catch (cause) {
    if (cause instanceof ArtifactBundleError) throw cause;
    throw new ArtifactBundleError(
      artifact.name,
      cause instanceof Error ? cause.message : String(cause),
    );
  } finally {
    await bundle.close();
  }
};

export const bundleArtifacts = async (
  projectRoot: string,
  artifacts: ReadonlyArray<ArtifactManifest>,
  resolveDir: string | undefined,
): Promise<ReadonlyArray<BuiltArtifact>> => {
  const built: Array<BuiltArtifact> = [];
  for (const artifact of artifacts) {
    built.push(await bundleOne(projectRoot, artifact, resolveDir));
  }
  return built;
};
