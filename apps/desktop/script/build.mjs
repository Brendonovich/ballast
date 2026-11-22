#!/usr/bin/env node
// Bundles the Electron main + preload with esbuild and copies the fallback page.
//
// We intentionally do not use electron-vite: the renderer is a tiny static
// "Starting Ballast…" page (the product UI is served by the agent service), so
// only main/preload need a bundler. Electron itself matches OpenCode Desktop
// (44.9.1), as does electron-builder (26.15.7).
import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export async function buildDesktop({ minify = true } = {}) {
  const out = path.join(root, "out");
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, "main"), { recursive: true });
  await mkdir(path.join(out, "preload"), { recursive: true });
  await mkdir(path.join(out, "renderer"), { recursive: true });

  await Promise.all([
    build({
      entryPoints: [path.join(root, "src/main/index.ts")],
      outfile: path.join(out, "main/index.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      minify,
      external: ["electron", "electron-updater"],
      logLevel: "warning",
    }),
    build({
      entryPoints: [path.join(root, "src/preload/index.ts")],
      outfile: path.join(out, "preload/index.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      sourcemap: true,
      minify,
      external: ["electron"],
      logLevel: "warning",
    }),
  ]);

  await cp(path.join(root, "src/renderer"), path.join(out, "renderer"), { recursive: true });

  const main = await stat(path.join(out, "main/index.js"));
  const preload = await stat(path.join(out, "preload/index.cjs"));
  console.log(
    "built out/main/index.js (" +
      (main.size / 1024).toFixed(1) +
      " KiB) and out/preload/index.cjs (" +
      (preload.size / 1024).toFixed(1) +
      " KiB)",
  );

  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildDesktop();
}
