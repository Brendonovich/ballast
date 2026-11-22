import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

export const ensureDir = async (path: string, mode = 0o700): Promise<void> => {
  await mkdir(path, { recursive: true, mode });
};

export const readJson = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

export const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * Write JSON atomically with restrictive permissions. The temporary file is
 * renamed over the target, so a crash never leaves a partial document.
 */
export const writeJsonAtomic = async (
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> => {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
};

export const writeTextAtomic = async (
  path: string,
  value: string,
  mode = 0o600,
): Promise<void> => {
  await ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
};

export const removeFile = async (path: string): Promise<void> => {
  await rm(path, { force: true });
};

export const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
};

export const contentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);
