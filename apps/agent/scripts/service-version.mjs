// Hash every file in a staged service build. The desktop app treats a version
// directory as immutable and only replaces a running service when the version
// changes, so the version must cover copied type packages and node_modules as
// well as the bundles.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const collect = async (directory, relative, exclude, entries) => {
  const children = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
  if (children === undefined) {
    entries.push({ path: relative, file: directory });
    return;
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  entries.push({ path: relative, directory: true });
  for (const child of children) {
    const path = join(directory, child.name);
    const next = relative === "" ? child.name : relative + "/" + child.name;
    if (exclude.has(next)) continue;
    await collect(path, next, exclude, entries);
  }
};

/**
 * First 10 hex characters of a SHA-256 over the staged tree. `version.json`
 * is excluded because it is written from this hash.
 */
export const serviceContentHash = async (outDir, options = {}) => {
  const exclude = new Set(options.exclude ?? ["version.json"]);
  const entries = [];
  await collect(outDir, "", exclude, entries);
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path.split("\\").join("/"));
    hash.update("\u0000");
    if (entry.file !== undefined) {
      hash.update("file\u0000");
      hash.update(await readFile(entry.file));
    } else {
      hash.update("dir\u0000");
    }
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 10);
};
