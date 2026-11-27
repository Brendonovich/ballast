#!/usr/bin/env node
// Copies the built @sceneify/core-rewrite (package.json, LICENSE and dist/) from a sceneify
// checkout into vendor/sceneify-core-rewrite, which the workspace depends on. Ballast needs the
// Effect 4 rewrite before it is published, and CI has no sibling checkout to build it from.
//
//   node scripts/vendor-sceneify.mjs [<sceneify checkout>]   (default ../sceneify)
//
// Build it first (`pnpm --filter @sceneify/core-rewrite build` in sceneify), then run
// `pnpm install` here.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sceneify = path.resolve(process.argv[2] ?? path.join(root, "..", "sceneify"));
const source = path.join(sceneify, "packages", "core-rewrite");
const target = path.join(root, "vendor", "sceneify-core-rewrite");

const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(path.join(source, "dist"), path.join(target, "dist"), {
  recursive: true,
  filter: (file) => !file.endsWith(".map") && !file.endsWith(".tsbuildinfo"),
});
await cp(path.join(sceneify, "LICENSE"), path.join(target, "LICENSE"));
const { name, version, type, main, types, exports, dependencies, peerDependencies } = pkg;
await writeFile(
  path.join(target, "package.json"),
  JSON.stringify({ name, version, private: true, type, main, types, exports, dependencies, peerDependencies }, null, 2) + "\n",
);
console.log("vendored " + name + " from " + source);
