import { basename } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { emptyManifest, type Manifest } from "@ballast/core";
import { bundleArtifacts } from "./artifacts.ts";
import type { BuiltArtifact } from "./artifacts.ts";
import { diff } from "./diff.ts";
import type { ManifestDiff } from "./diff.ts";
import { planDetails } from "./plan-worker-client.ts";
import type { PlanOptions } from "./plan.ts";
import { resolveProjectEntry } from "./project.ts";
import type { ProjectEntry, ProjectEntryError } from "./project.ts";
import { typecheckProject } from "./typecheck.ts";
import type { TypecheckDiagnostic, TypecheckError } from "./typecheck.ts";

export class ProjectPlanError extends Data.TaggedError("ProjectPlanError")<{
  readonly message: string;
  readonly diagnostics: ReadonlyArray<TypecheckDiagnostic>;
}> {}

export interface PlannedProject {
  readonly entry: ProjectEntry;
  readonly manifest: Manifest;
  readonly title: string;
  readonly typecheck: ReadonlyArray<TypecheckDiagnostic>;
  readonly artifacts: ReadonlyArray<BuiltArtifact>;
}

export const planProject = (
  projectRoot: string,
  options: Omit<PlanOptions, "projectRoot"> = {},
): Effect.Effect<
  PlannedProject,
  ProjectPlanError | ProjectEntryError | TypecheckError
> =>
  Effect.gen(function* () {
    const entry = yield* resolveProjectEntry(projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new ProjectPlanError({
            message: error.message,
            diagnostics: [],
          }),
      ),
    );
    const checked = yield* typecheckProject(entry.root, { entry: entry.entryFile });
    if (!checked.ok) {
      const first = checked.diagnostics[0];
      return yield* Effect.fail(
        new ProjectPlanError({
          message:
            first === undefined
              ? "Typecheck failed: " + checked.raw.trim()
              : first.file + ":" + first.line + ":" + first.column + " — " + first.message,
          diagnostics: checked.diagnostics,
        }),
      );
    }
    const planned = yield* planDetails(entry.entryFile, {
      ...options,
      scriptId: entry.entry,
      projectId: options.projectId ?? basename(entry.root),
      projectRoot: entry.root,
      projectEntry: entry.entry,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ProjectPlanError({
            message: error.message,
            diagnostics: [],
          }),
      ),
    );
    const artifacts = yield* Effect.tryPromise({
      try: () =>
        bundleArtifacts(entry.root, planned.manifest.artifacts, options.resolveDir),
      catch: (error) =>
        new ProjectPlanError({
          message: error instanceof Error ? error.message : String(error),
          diagnostics: [],
        }),
    });
    return {
      entry,
      manifest: planned.manifest,
      title: planned.title,
      typecheck: checked.diagnostics,
      artifacts,
    };
  });

export type UnitKind =
  | "topic"
  | "timer"
  | "workflow"
  | "param"
  | "run"
  | "artifact"
  | "api"
  | "store"
  | "database";

export interface UnitChange {
  readonly kind: UnitKind;
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: unknown;
  readonly after?: unknown;
  readonly source?: { readonly file: string; readonly line: number; readonly column: number };
}

export interface ProjectManifestDiff {
  readonly requiresConsent: boolean;
  readonly changes: ReadonlyArray<UnitChange>;
  readonly units: ManifestDiff;
  /** True when every change is an artifact bundle and the worker can stay up. */
  readonly artifactOnly: boolean;
  /** True when the service must start a new worker generation. */
  readonly requiresWorkerRestart: boolean;
}

const normalize = (value: unknown): string => JSON.stringify(value);

const changesFor = <A>(
  kind: UnitKind,
  key: (value: A) => string,
  previous: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
): ReadonlyArray<UnitChange> => {
  const before = new Map(previous.map((value) => [key(value), value]));
  const after = new Map(next.map((value) => [key(value), value]));
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes: Array<UnitChange> = [];
  for (const name of names) {
    const left = before.get(name);
    const right = after.get(name);
    if (left === undefined) {
      changes.push({ kind, name, change: "added", after: right });
    } else if (right === undefined) {
      changes.push({ kind, name, change: "removed", before: left });
    } else if (normalize(left) !== normalize(right)) {
      changes.push({ kind, name, change: "changed", before: left, after: right });
    }
  }
  return changes;
};

/**
 * Unit-level project diff: added/removed/changed by kind + name. Consent is
 * driven by the existing permission diff (new scopes or connections).
 */
export const diffProject = (
  previous: Manifest | undefined,
  next: Manifest | undefined,
): ProjectManifestDiff => {
  if (next === undefined) {
    const before = previous ?? emptyManifest("unknown", "ballast.ts");
    return {
      requiresConsent: false,
      changes: [],
      units: diff(before, before),
      artifactOnly: false,
      requiresWorkerRestart: false,
    };
  }
  const before = previous ?? emptyManifest(next.project.id, next.project.entry);
  const permissions = diff(before, next);
  const changes: Array<UnitChange> = [
    ...changesFor("topic", (value) => value.name, before.topics, next.topics),
    ...changesFor("timer", (value) => value.name, before.timers, next.timers),
    ...changesFor(
      "workflow",
      (value) => value.name,
      before.workflows,
      next.workflows,
    ),
    ...changesFor("param", (value) => value.key, before.params, next.params),
    ...changesFor("run", (value) => value.name, before.runs, next.runs),
    ...changesFor(
      "artifact",
      (value) => value.name,
      before.artifacts ?? [],
      next.artifacts ?? [],
    ),
    ...changesFor(
      "store",
      (value) => value.name,
      before.stores ?? [],
      next.stores ?? [],
    ),
    ...changesFor(
      "database",
      (value) => value.name,
      before.databases ?? [],
      next.databases ?? [],
    ),
  ];
  if (permissions.api?.changed === true) {
    changes.push({
      kind: "api",
      name: "project-api",
      change:
        permissions.api.previous === undefined
          ? "added"
          : permissions.api.next === undefined
            ? "removed"
            : "changed",
      ...(permissions.api.previous === undefined
        ? {}
        : { before: permissions.api.previous }),
      ...(permissions.api.next === undefined ? {} : { after: permissions.api.next }),
      ...(permissions.api.next?.source === undefined
        ? {}
        : { source: permissions.api.next.source }),
    });
  }
  const artifactOnly =
    changes.length > 0 && changes.every((change) => change.kind === "artifact");
  return {
    requiresConsent: permissions.requiresConsent,
    changes,
    units: permissions,
    artifactOnly,
    requiresWorkerRestart: changes.some((change) => change.kind !== "artifact"),
  };
};
