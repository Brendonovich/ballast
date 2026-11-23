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

export interface StoredArtifactWindow {
  readonly projectId: string;
  readonly artifact: string;
  readonly bounds?: StoredBounds;
}

export interface RestoredWindows {
  readonly projects: ReadonlyArray<StoredProjectWindow>;
  readonly artifacts: ReadonlyArray<StoredArtifactWindow>;
}

interface WindowSessionFile {
  readonly version: 1;
  readonly projects: ReadonlyArray<StoredProjectWindow>;
  readonly artifacts: ReadonlyArray<StoredArtifactWindow>;
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
): Promise<RestoredWindows> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionPath(userDataDir), "utf8"));
    if (!isRecord(parsed) || parsed["version"] !== 1) {
      return { projects: [], artifacts: [] };
    }
    const projectIds = new Set<string>();
    const projects: Array<StoredProjectWindow> = [];
    const projectEntries = Array.isArray(parsed["projects"]) ? parsed["projects"] : [];
    for (const entry of projectEntries) {
      if (!isRecord(entry)) continue;
      const projectId = entry["projectId"];
      if (typeof projectId !== "string" || projectId === "" || projectIds.has(projectId)) continue;
      projectIds.add(projectId);
      const bounds = boundsOf(entry["bounds"]);
      projects.push({ projectId, ...(bounds === undefined ? {} : { bounds }) });
    }
    const artifactKeys = new Set<string>();
    const artifacts: Array<StoredArtifactWindow> = [];
    const artifactEntries = Array.isArray(parsed["artifacts"]) ? parsed["artifacts"] : [];
    for (const entry of artifactEntries) {
      if (!isRecord(entry)) continue;
      const projectId = entry["projectId"];
      const artifact = entry["artifact"];
      if (
        typeof projectId !== "string" ||
        projectId === "" ||
        typeof artifact !== "string" ||
        artifact === ""
      ) {
        continue;
      }
      const key = projectId + "\u0000" + artifact;
      if (artifactKeys.has(key)) continue;
      artifactKeys.add(key);
      const bounds = boundsOf(entry["bounds"]);
      artifacts.push({ projectId, artifact, ...(bounds === undefined ? {} : { bounds }) });
    }
    return { projects, artifacts };
  } catch {
    return { projects: [], artifacts: [] };
  }
};

const contentOf = (session: RestoredWindows): string =>
  JSON.stringify({ version: 1, ...session } satisfies WindowSessionFile);

export const writeWindowSession = async (
  userDataDir: string,
  session: RestoredWindows,
): Promise<void> => {
  await mkdir(userDataDir, { recursive: true });
  const target = sessionPath(userDataDir);
  const temporary = target + ".tmp";
  await writeFile(temporary, contentOf(session), "utf8");
  await rename(temporary, target);
};

/** Quit-time write must finish before Electron exits. */
export const writeWindowSessionSync = (
  userDataDir: string,
  session: RestoredWindows,
): void => {
  mkdirSync(userDataDir, { recursive: true });
  const target = sessionPath(userDataDir);
  const temporary = target + ".tmp";
  writeFileSync(temporary, contentOf(session), "utf8");
  renameSync(temporary, target);
};
