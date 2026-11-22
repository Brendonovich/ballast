#!/usr/bin/env node
// Copies the service build into build-service/ so electron-builder can put it
// outside app.asar (extraResources: build-service -> Resources/service).
//
// Point this at the real service once apps/agent produces a serve build:
//   BALLAST_SERVICE_BUILD_DIR=../agent/dist/serve pnpm --filter @ballast/desktop pack
//
// The source directory must contain main.mjs and should contain
// plan-worker.mjs and web/index.html (see docs/decisions/0003 §2).
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.resolve(root, process.env.BALLAST_SERVICE_BUILD_DIR ?? "dev/stub-service");
const destination = path.join(root, "build-service");

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readVersion() {
  const explicit = process.env.BALLAST_SERVICE_VERSION;
  if (explicit) return explicit;
  try {
    const parsed = JSON.parse(await readFile(path.join(source, "version.json"), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.length > 0) return parsed.version;
  } catch {
    // fall through to package.json
  }
  try {
    const parsed = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.length > 0) return parsed.version;
  } catch {
    // fall through
  }
  return "0.0.0-dev";
}

if (!(await exists(path.join(source, "main.mjs")))) {
  throw new Error("service build has no main.mjs: " + source);
}

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, dereference: true });

const version = await readVersion();
await writeFile(path.join(destination, "version.json"), JSON.stringify({ version }, null, 2) + "\n");

for (const required of ["plan-worker.mjs", "web/index.html"]) {
  if (!(await exists(path.join(destination, required)))) {
    console.warn("warning: service build is missing " + required + " (expected by the stage layout)");
  }
}

console.log("prepared service " + version + " from " + source + " -> " + destination);
