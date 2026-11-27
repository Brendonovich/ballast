import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import { ProjectShare, agentError } from "@ballast/agent-protocol";
import type { AgentError } from "@ballast/agent-protocol";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.ts";

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Sharing state (decision 0013). */
  readonly share?: ProjectShare;
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
    readonly share?: ProjectShare;
  }) => Effect.Effect<ProjectRecord, AgentError>;
  readonly setShare: (
    projectId: string,
    share: ProjectShare | undefined,
  ) => Effect.Effect<ProjectRecord, AgentError>;
  readonly remove: (projectId: string) => Effect.Effect<void, AgentError>;
  readonly touch: (projectId: string) => Effect.Effect<void>;
  readonly scan: (project: ProjectRecord) => Effect.Effect<ReadonlyArray<DiscoveredScript>>;
  readonly scriptPath: (project: ProjectRecord, scriptId: string) => string;
}

export class ProjectManager extends Context.Service<ProjectManager, ProjectManagerService>()(
  "ballast/service/ProjectManager",
) {}

export const projectsJsonPath = (path: Path.Path, dataDir: string): string =>
  path.join(dataDir, "projects.json");

const projectRootKey = (path: Path.Path, root: string): string => path.resolve(root);

const isDirectory = (
  path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );

const loadRegistry = (
  dataDir: string,
): Effect.Effect<ProjectRegistry, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const value = yield* readJson(projectsJsonPath(path, dataDir)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
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
      const share = Schema.decodeUnknownOption(ProjectShare)(entry["share"]);
      parsed.push({
        id: entry["id"],
        name: entry["name"],
        root: path.resolve(entry["root"]),
        createdAt: typeof entry["createdAt"] === "number" ? entry["createdAt"] : Date.now(),
        updatedAt: typeof entry["updatedAt"] === "number" ? entry["updatedAt"] : Date.now(),
        ...(share._tag === "Some" ? { share: share.value } : {}),
      });
    }
    return { version: 1, projects: parsed };
  });

const isScriptFile = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".d.ts") &&
  !name.endsWith(".test.ts") &&
  !name.startsWith(".");

const scriptNameOf = (path: Path.Path, id: string): string => {
  const file = path.basename(id).replace(/\.ts$/, "");
  return file
    .split(/[-_.]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || file;
};

const toPosix = (path: Path.Path, value: string): string => value.split(path.sep).join("/");

const scanDirectory = (
  project: ProjectRecord,
  directory: string,
  found: Array<DiscoveredScript>,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.catch(() => Effect.succeed([] as Array<string>)),
    );
    entries.sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const absolutePath = path.join(directory, name);
      const info = yield* fs.stat(absolutePath).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (info === undefined) continue;
      if (info.type === "Directory") {
        yield* scanDirectory(project, absolutePath, found);
        continue;
      }
      if (info.type !== "File" || !isScriptFile(name)) continue;
      const id = toPosix(path, path.relative(project.root, absolutePath));
      found.push({ id, absolutePath, name: scriptNameOf(path, id) });
    }
  });

export const ProjectManagerLive = (dataDir: string) =>
  Layer.effect(
    ProjectManager,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const platform = yield* Effect.context<
        SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
      >();
      const provide = <A, E>(
        effect: Effect.Effect<A, E, SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path>,
      ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
      const registry = yield* Ref.make(yield* loadRegistry(dataDir));

      const save = (state: ProjectRegistry): Effect.Effect<void> =>
        provide(
          writeJsonAtomic(projectsJsonPath(path, dataDir), state, 0o600),
        ).pipe(Effect.ignore);

      const projects = Effect.map(Ref.get(registry), (state) => state.projects);

      const get = (projectId: string): Effect.Effect<ProjectRecord | undefined> =>
        Effect.map(projects, (items) => items.find((project) => project.id === projectId));

      const add = (input: {
        readonly path: string;
        readonly name?: string;
        readonly share?: ProjectShare;
      }): Effect.Effect<ProjectRecord, AgentError> =>
        Effect.gen(function* () {
          const raw = input.path.trim();
          if (raw === "") {
            return yield* Effect.fail(agentError("invalid", "A project path is required"));
          }
          const root = path.resolve(raw);
          if (!(yield* provide(isDirectory(root)))) {
            return yield* Effect.fail(
              agentError("invalid", `"${root}" is not a directory`),
            );
          }
          const current = yield* Ref.get(registry);
          if (current.projects.some((project) => projectRootKey(path, project.root) === projectRootKey(path, root))) {
            return yield* Effect.fail(
              agentError("conflict", `A project already watches "${root}"`),
            );
          }
          const now = Date.now();
          const crypto = Context.get(platform, SecureRandom.SecureRandom);
          const id = yield* crypto.randomBytes(4).pipe(
            Effect.map((bytes) => `proj_${Hex.encode(bytes)}`),
            Effect.orDie,
          );
          const project: ProjectRecord = {
            id,
            name: input.name?.trim() || path.basename(root) || "Project",
            root,
            createdAt: now,
            updatedAt: now,
            ...(input.share === undefined ? {} : { share: input.share }),
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

      const setShare = (
        projectId: string,
        share: ProjectShare | undefined,
      ): Effect.Effect<ProjectRecord, AgentError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(registry);
          const existing = current.projects.find((project) => project.id === projectId);
          if (existing === undefined) {
            return yield* Effect.fail(agentError("not-found", `No project "${projectId}"`));
          }
          const { share: _previous, ...rest } = existing;
          const updated: ProjectRecord = {
            ...rest,
            updatedAt: Date.now(),
            ...(share === undefined ? {} : { share }),
          };
          const next: ProjectRegistry = {
            version: 1,
            projects: current.projects.map((project) =>
              project.id === projectId ? updated : project,
            ),
          };
          yield* Ref.set(registry, next);
          yield* save(next);
          return updated;
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
        Effect.gen(function* () {
          const found: Array<DiscoveredScript> = [];
          yield* provide(
            scanDirectory(project, path.join(project.root, "scripts"), found),
          );
          return found;
        });

      return {
        projects,
        get,
        add,
        setShare,
        remove,
        touch,
        scan,
        scriptPath: (project, scriptId) => path.join(project.root, scriptId),
      };
    }),
  );

/** Ensure the state directory for a project exists. */
export const ensureProjectStateDir = (
  project: ProjectRecord,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* ensureDir(path.join(project.root, ".ballast"));
  }).pipe(Effect.ignore);
