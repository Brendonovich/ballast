import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopConfig } from "../config.ts";
import type { ServiceBuild, Stage, StageRef } from "./types.ts";

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

export function assertVersion(version: string): void {
  if (!versionPattern.test(version)) throw new Error("invalid service version: " + version);
}

export function stageDirectory(root: string, version: string): string {
  assertVersion(version);
  return path.join(root, version);
}

export function stageRef(root: string, version: string): StageRef {
  return { version, directory: stageDirectory(root, version) };
}

export function asStage(ref: StageRef): Stage {
  return {
    version: ref.version,
    directory: ref.directory,
    entry: path.join(ref.directory, "main.mjs"),
    worker: path.join(ref.directory, "plan-worker.mjs"),
    web: path.join(ref.directory, "web"),
  };
}

async function pathType(file: string): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(file);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return undefined;
  } catch {
    return undefined;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function versionFrom(directory: string): Promise<string | undefined> {
  const fromFile = await readJson(path.join(directory, "version.json"));
  if (record(fromFile)) {
    const version = fromFile["version"];
    if (typeof version === "string" && version.length > 0) return version;
  }
  const fromPackage = await readJson(path.join(directory, "package.json"));
  if (record(fromPackage)) {
    const version = fromPackage["version"];
    if (typeof version === "string" && version.length > 0) return version;
  }
  return undefined;
}

/** Resolve the shipped/configured service build. Throws when main.mjs is missing. */
export async function resolveServiceBuild(config: DesktopConfig): Promise<ServiceBuild> {
  const version = config.serviceVersion ?? (await versionFrom(config.serviceBuildDir)) ?? "0.0.0-dev";
  assertVersion(version);
  if ((await pathType(path.join(config.serviceBuildDir, "main.mjs"))) !== "file") {
    throw new Error("service build has no main.mjs: " + config.serviceBuildDir);
  }
  return { version, directory: config.serviceBuildDir };
}

/**
 * Copy a service build into <userData>/service/<version>.
 *
 * A stage is never overwritten: once the directory has main.mjs it is reused
 * as-is, even if the app ships a different build with the same version. That
 * keeps a running service's files stable across app updates (0003 §2).
 */
export async function stageService(config: DesktopConfig, build: ServiceBuild): Promise<Stage> {
  assertVersion(build.version);
  const directory = stageDirectory(config.stageRoot, build.version);
  const entry = path.join(directory, "main.mjs");

  if ((await pathType(entry)) === "file") return asStage({ version: build.version, directory });
  if ((await pathType(directory)) === "directory") {
    throw new Error("service stage exists but is incomplete: " + directory + " (remove it and retry)");
  }

  await mkdir(config.stageRoot, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    config.stageRoot,
    "." + build.version + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp",
  );
  await cp(build.directory, temporary, { recursive: true, dereference: true });
  if ((await pathType(path.join(temporary, "main.mjs"))) !== "file") {
    await rm(temporary, { recursive: true, force: true });
    throw new Error("service build is missing main.mjs: " + build.directory);
  }
  await writeFile(
    path.join(temporary, ".ballast-stage.json"),
    JSON.stringify({ version: build.version, stagedAt: Date.now(), source: build.directory }, null, 2) + "\n",
    { mode: 0o600 },
  );
  try {
    await rename(temporary, directory);
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    if ((await pathType(entry)) === "file") return asStage({ version: build.version, directory });
    throw cause;
  }

  return asStage({ version: build.version, directory });
}

/** An already-staged version (for rolling back to a running service's stage), if complete. */
export async function existingStage(config: DesktopConfig, version: string): Promise<Stage | undefined> {
  if (!versionPattern.test(version)) return undefined;
  const stage = asStage(stageRef(config.stageRoot, version));
  return (await pathType(stage.entry)) === "file" ? stage : undefined;
}

/** Remove all version stages except the ones still referenced. Failures are ignored. */
export async function cleanStages(config: DesktopConfig, keepVersions: ReadonlyArray<string>): Promise<string[]> {
  const keep = new Set(keepVersions);
  let entries: string[];
  try {
    entries = await readdir(config.stageRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    const target = path.join(config.stageRoot, entry);
    if ((await pathType(target)) !== "directory") continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // A running Windows service may still hold a file; retry on the next launch.
    }
  }
  return removed;
}
