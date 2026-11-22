import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { agentError } from "@ballast/agent-protocol";
import type { AgentError } from "@ballast/agent-protocol";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.ts";

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DiscoveredScript {
  /** Path relative to the project root, for example `scripts/tick-echo.ts`. */
  readonly id: string;
  readonly absolutePath: string;
  readonly name: string;
}

interface ProjectRegistry {
  readonly version: 1;
  readonly projects: ReadonlyArray<ProjectRecord>;
}

interface ProjectManagerService {
  readonly projects: Effect.Effect<ReadonlyArray<ProjectRecord>>;
  readonly get: (projectId: string) => Effect.Effect<ProjectRecord | undefined>;
  readonly add: (input: {
    readonly path: string;
    readonly name?: string;
  }) => Effect.Effect<ProjectRecord, AgentError>;
  readonly remove: (projectId: string) => Effect.Effect<void, AgentError>;
  readonly touch: (projectId: string) => Effect.Effect<void>;
  readonly scan: (project: ProjectRecord) => Effect.Effect<ReadonlyArray<DiscoveredScript>>;
  readonly scriptPath: (project: ProjectRecord, scriptId: string) => string;
}

export class ProjectManager extends Context.Service<ProjectManager, ProjectManagerService>()(
  "ballast/service/ProjectManager",
) {}

export const projectsJsonPath = (dataDir: string): string => join(dataDir, "projects.json");

const projectRootKey = (root: string): string => resolve(root);

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const loadRegistry = async (dataDir: string): Promise<ProjectRegistry> => {
  const value = await readJson(projectsJsonPath(dataDir));
  if (value === undefined) return { version: 1, projects: [] };
  if (typeof value !== "object" || value === null) return { version: 1, projects: [] };
  const record = value as Record<string, unknown>;
  const projects = record["projects"];
  if (!Array.isArray(projects)) return { version: 1, projects: [] };
  const parsed: Array<ProjectRecord> = [];
  for (const item of projects) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry["id"] !== "string" ||
      typeof entry["name"] !== "string" ||
      typeof entry["root"] !== "string"
    ) {
      continue;
    }
    parsed.push({
      id: entry["id"],
      name: entry["name"],
      root: resolve(entry["root"]),
      createdAt: typeof entry["createdAt"] === "number" ? entry["createdAt"] : Date.now(),
      updatedAt: typeof entry["updatedAt"] === "number" ? entry["updatedAt"] : Date.now(),
    });
  }
  return { version: 1, projects: parsed };
};

const isScriptFile = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".d.ts") &&
  !name.endsWith(".test.ts") &&
  !name.startsWith(".");

const scriptNameOf = (id: string): string => {
  const file = basename(id).replace(/\.ts$/, "");
  return file
    .split(/[-_.]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || file;
};

const toPosix = (path: string): string => path.split(sep).join("/");

const scanDirectory = async (
  project: ProjectRecord,
  directory: string,
  found: Array<DiscoveredScript>,
): Promise<void> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(project, absolutePath, found);
      continue;
    }
    if (!entry.isFile() || !isScriptFile(entry.name)) continue;
    const id = toPosix(relative(project.root, absolutePath));
    found.push({ id, absolutePath, name: scriptNameOf(id) });
  }
};

export const ProjectManagerLive = (dataDir: string) =>
  Layer.effect(
    ProjectManager,
    Effect.gen(function* () {
      const registry = yield* Ref.make(yield* Effect.promise(() => loadRegistry(dataDir)));

      const save = (state: ProjectRegistry): Effect.Effect<void> =>
        Effect.tryPromise({
          try: () => writeJsonAtomic(projectsJsonPath(dataDir), state, 0o600),
          catch: () => undefined,
        }).pipe(Effect.ignore);

      const projects = Effect.map(Ref.get(registry), (state) => state.projects);

      const get = (projectId: string): Effect.Effect<ProjectRecord | undefined> =>
        Effect.map(projects, (items) => items.find((project) => project.id === projectId));

      const add = (input: {
        readonly path: string;
        readonly name?: string;
      }): Effect.Effect<ProjectRecord, AgentError> =>
        Effect.gen(function* () {
          const raw = input.path.trim();
          if (raw === "") {
            return yield* Effect.fail(agentError("invalid", "A project path is required"));
          }
          const root = resolve(raw);
          if (!(yield* Effect.promise(() => isDirectory(root)))) {
            return yield* Effect.fail(
              agentError("invalid", `"${root}" is not a directory`),
            );
          }
          const current = yield* Ref.get(registry);
          if (current.projects.some((project) => projectRootKey(project.root) === projectRootKey(root))) {
            return yield* Effect.fail(
              agentError("conflict", `A project already watches "${root}"`),
            );
          }
          const now = Date.now();
          const project: ProjectRecord = {
            id: `proj_${randomBytes(4).toString("hex")}`,
            name: input.name?.trim() || basename(root) || "Project",
            root,
            createdAt: now,
            updatedAt: now,
          };
          const next: ProjectRegistry = {
            version: 1,
            projects: [...current.projects, project],
          };
          yield* Ref.set(registry, next);
          yield* save(next);
          return project;
        });

      const remove = (projectId: string): Effect.Effect<void, AgentError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(registry);
          if (!current.projects.some((project) => project.id === projectId)) {
            return yield* Effect.fail(
              agentError("not-found", `No project "${projectId}"`),
            );
          }
          const next: ProjectRegistry = {
            version: 1,
            projects: current.projects.filter((project) => project.id !== projectId),
          };
          yield* Ref.set(registry, next);
          yield* save(next);
        });

      const touch = (projectId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(registry);
          const next: ProjectRegistry = {
            version: 1,
            projects: current.projects.map((project) =>
              project.id === projectId ? { ...project, updatedAt: Date.now() } : project,
            ),
          };
          yield* Ref.set(registry, next);
          yield* save(next);
        });

      const scan = (
        project: ProjectRecord,
      ): Effect.Effect<ReadonlyArray<DiscoveredScript>> =>
        Effect.promise(() =>
          Effect.runPromise(
            Effect.gen(function* () {
              const found: Array<DiscoveredScript> = [];
              yield* Effect.promise(() =>
                scanDirectory(project, join(project.root, "scripts"), found),
              );
              return found;
            }),
          ),
        );

      return {
        projects,
        get,
        add,
        remove,
        touch,
        scan,
        scriptPath: (project, scriptId) => join(project.root, scriptId),
      };
    }),
  );

/** Ensure the state directory for a project exists. */
export const ensureProjectStateDir = (project: ProjectRecord): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => ensureDir(join(project.root, ".ballast")),
    catch: () => undefined,
  }).pipe(Effect.ignore);
