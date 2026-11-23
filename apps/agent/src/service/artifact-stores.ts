import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { readJson, writeJsonAtomic } from "./fs.ts";
import type { ProjectRecord } from "./projects.ts";

interface CounterFile {
  readonly version: 1;
  readonly kind: "counter";
  readonly value: number;
}

export interface StoreLoadSpec {
  readonly name: string;
  readonly kind: "counter";
  readonly initial?: number;
}

export interface ProjectStoreService {
  readonly load: (project: ProjectRecord, spec: StoreLoadSpec) => Effect.Effect<unknown>;
  readonly setCounter: (project: ProjectRecord, name: string, value: number) => Effect.Effect<number>;
  readonly increment: (
    project: ProjectRecord,
    name: string,
    by: number,
    initial: number,
  ) => Effect.Effect<number>;
}

export class ProjectStores extends Context.Service<ProjectStores, ProjectStoreService>()(
  "ballast/service/ProjectStores",
) {}

const storePath = (path: Path.Path, project: ProjectRecord, name: string): string =>
  path.join(project.root, ".ballast", "stores", name + ".json");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const readCounter = (
  file: string,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const value = yield* readJson(file).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (!isRecord(value) || value["kind"] !== "counter") return undefined;
    const current = value["value"];
    return typeof current === "number" && Number.isFinite(current) ? current : undefined;
  });

export const ProjectStoresLive = Layer.effect(
  ProjectStores,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const semaphore = yield* Semaphore.make(1);
    const platform = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);

    return ProjectStores.of({
      load: (project, spec) =>
        semaphore.withPermit(
          provide(
            Effect.gen(function* () {
              const current = yield* readCounter(storePath(path, project, spec.name));
              return current ?? spec.initial ?? 0;
            }),
          ),
        ),
      setCounter: (project, name, value) =>
        semaphore.withPermit(
          provide(
            Effect.gen(function* () {
              const file: CounterFile = { version: 1, kind: "counter", value };
              yield* writeJsonAtomic(storePath(path, project, name), file).pipe(Effect.orDie);
              return value;
            }),
          ),
        ),
      increment: (project, name, by, initial) =>
        semaphore.withPermit(
          provide(
            Effect.gen(function* () {
              const file = storePath(path, project, name);
              const current = (yield* readCounter(file)) ?? initial;
              const next = current + by;
              yield* writeJsonAtomic(file, {
                version: 1,
                kind: "counter",
                value: next,
              } satisfies CounterFile).pipe(Effect.orDie);
              return next;
            }),
          ),
        ),
    });
  }),
);
