import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StoredProjectWindow {
  readonly projectId: string;
  readonly bounds?: StoredBounds;
}

interface WindowSessionFile {
  readonly version: 1;
  readonly projects: ReadonlyArray<StoredProjectWindow>;
}

const sessionPath = (userDataDir: string): string =>
  path.join(userDataDir, "windows.json");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const boundsOf = (value: unknown): StoredBounds | undefined => {
  if (!isRecord(value)) return undefined;
  const x = value["x"];
  const y = value["y"];
  const width = value["width"];
  const height = value["height"];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 400 ||
    height < 300
  ) {
    return undefined;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
};

/** Project windows to reopen after a relaunch. Missing or malformed files mean a fresh start. */
export const readWindowSession = async (
  userDataDir: string,
): Promise<ReadonlyArray<StoredProjectWindow>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionPath(userDataDir), "utf8"));
    if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["projects"])) {
      return [];
    }
    const seen = new Set<string>();
    const projects: Array<StoredProjectWindow> = [];
    for (const entry of parsed["projects"]) {
      if (!isRecord(entry)) continue;
      const projectId = entry["projectId"];
      if (typeof projectId !== "string" || projectId === "" || seen.has(projectId)) continue;
      seen.add(projectId);
      const bounds = boundsOf(entry["bounds"]);
      projects.push({ projectId, ...(bounds === undefined ? {} : { bounds }) });
    }
    return projects;
  } catch {
    return [];
  }
};

const contentOf = (projects: ReadonlyArray<StoredProjectWindow>): string =>
  JSON.stringify({ version: 1, projects } satisfies WindowSessionFile);

export const writeWindowSession = async (
  userDataDir: string,
  projects: ReadonlyArray<StoredProjectWindow>,
): Promise<void> => {
  await mkdir(userDataDir, { recursive: true });
  const target = sessionPath(userDataDir);
  const temporary = target + ".tmp";
  await writeFile(temporary, contentOf(projects), "utf8");
  await rename(temporary, target);
};

/** Quit-time write must finish before Electron exits. */
export const writeWindowSessionSync = (
  userDataDir: string,
  projects: ReadonlyArray<StoredProjectWindow>,
): void => {
  mkdirSync(userDataDir, { recursive: true });
  const target = sessionPath(userDataDir);
  const temporary = target + ".tmp";
  writeFileSync(temporary, contentOf(projects), "utf8");
  renameSync(temporary, target);
};
