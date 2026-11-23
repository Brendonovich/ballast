import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

export class ProjectEntryError extends Data.TaggedError("ProjectEntryError")<{
  readonly message: string;
}> {}

export interface ProjectEntry {
  readonly root: string;
  readonly entry: string;
  readonly entryFile: string;
}

const isInside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const readPackageEntry = async (root: string): Promise<string | undefined> => {
  try {
    const text = await readFile(resolve(root, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("ballast" in parsed)) {
      return undefined;
    }
    const ballast = parsed.ballast;
    if (typeof ballast !== "object" || ballast === null || !("entry" in ballast)) {
      return undefined;
    }
    return typeof ballast.entry === "string" ? ballast.entry : undefined;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Resolve one project's single entry. Default: `ballast.ts`; optional
 * `package.json#ballast.entry` override. The override must stay inside the
 * project and must exist.
 */
export const resolveProjectEntry = (
  projectRoot: string,
): Effect.Effect<ProjectEntry, ProjectEntryError> =>
  Effect.gen(function* () {
    const root = resolve(projectRoot);
    const override = yield* Effect.tryPromise({
      try: () => readPackageEntry(root),
      catch: (cause) =>
        new ProjectEntryError({
          message: `Cannot read ${root}/package.json: ${String(cause)}`,
        }),
    });
    const requested = override ?? "ballast.ts";
    const entryFile = resolve(root, requested);
    if (!isInside(root, entryFile)) {
      return yield* Effect.fail(
        new ProjectEntryError({
          message: `Project entry "${requested}" escapes ${root}`,
        }),
      );
    }
    if (!existsSync(entryFile)) {
      return yield* Effect.fail(
        new ProjectEntryError({
          message: `Project entry "${relative(root, entryFile).split(sep).join("/")}" does not exist`,
        }),
      );
    }
    return { root, entry: requested, entryFile };
  });

/** Read `package.json#ballast.entry` without validating the file. */
export const projectEntryOverride = (projectRoot: string): Promise<string | undefined> =>
  readPackageEntry(resolve(projectRoot));
