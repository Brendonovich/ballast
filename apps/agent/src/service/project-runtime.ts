import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import {
  agentError,
  type AgentError,
  type CancelTimerRequest,
  type ListTimersRequest,
  type ManifestConnection,
  type ManifestDiff,
  type ParamValue,
  type ParamView,
  type ProjectCheckResult,
  type ProjectConsentRequest,
  type ProjectDetail,
  type ProjectDiagnostic,
  type ProjectFile,
  type ProjectFileContent,
  type ProjectBinding,
  type ProjectManifest,
  type ProjectRequirement,
  type ProjectSummary,
  type ProjectUnitChange,
  type TimerSummary,
  type UnitSummary,
} from "@ballast/agent-protocol";
import { emptyManifest, type Manifest, type ParamManifest, type TimerManifest } from "@ballast/core";
import { diffProject, planProject, resolveProjectEntry } from "@ballast/planner";
import { bundleScript } from "../bundle.ts";
import { startRuntimeSession } from "../runtime-session.ts";
import type { RuntimeSession } from "../runtime-session.ts";
import { ConnectionManager } from "./connections.ts";
import type { ActiveScript } from "./connections.ts";
import { contentHash, readJson, writeJsonAtomic } from "./fs.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";
import { EventRouter, Logs, ServiceHub } from "./telemetry.ts";
import { makeTimerManager } from "./timers.ts";

const SETTINGS_FILE = "settings.json";
const APPLIED_FILE = "applied.json";
const BINDINGS_FILE = "bindings.json";

interface AppliedFile {
  readonly version: 1;
  readonly manifest: Manifest;
  readonly appliedAt: number;
}

interface ProjectRuntimeRecord {
  readonly project: ProjectRecord;
  readonly entry: string | undefined;
  readonly entryFile: string | undefined;
  readonly fingerprint: string | undefined;
  readonly manifest: Manifest | undefined;
  readonly appliedManifest: Manifest | undefined;
  readonly appliedAt: number | undefined;
  readonly status: ProjectSummary["status"];
  readonly enabled: boolean;
  readonly generation: number;
  readonly updatedAt: number;
  readonly lastError: string | undefined;
  readonly lastErrorKind: "plan" | "runtime" | undefined;
  readonly lastErrorSource: ProjectDetail["lastErrorSource"];
  readonly pendingConsent: ProjectConsentRequest | undefined;
  readonly params: Readonly<Record<string, ParamValue>>;
  /** "integration/slot" -> connection instance id. */
  readonly bindings: Readonly<Record<string, string>>;
  readonly session: RuntimeSession | undefined;
  readonly activity: ReadonlyMap<string, number>;
}

interface SettingsState {
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, ParamValue>>;
}

type Binding = {
  readonly id: string;
  readonly status: NonNullable<ManifestConnection["connectionStatus"]>;
};

export interface ProjectRuntimeService {
  readonly summaries: () => Effect.Effect<ReadonlyArray<ProjectSummary>>;
  readonly summary: (projectId: string) => Effect.Effect<ProjectSummary | undefined>;
  readonly detail: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly files: (projectId: string) => Effect.Effect<{ readonly entry: string; readonly files: ReadonlyArray<ProjectFile> }, AgentError>;
  readonly readFile: (projectId: string, path: string) => Effect.Effect<ProjectFileContent, AgentError>;
  readonly entrySource: (projectId: string) => Effect.Effect<ProjectFileContent, AgentError>;
  readonly plan: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly check: (projectId: string) => Effect.Effect<ProjectCheckResult, AgentError>;
  readonly start: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly stop: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly restart: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly setParam: (projectId: string, key: string, value: ParamValue) => Effect.Effect<ProjectDetail, AgentError>;
  readonly setEnabled: (projectId: string, enabled: boolean) => Effect.Effect<ProjectDetail, AgentError>;
  readonly setBinding: (request: {
    readonly projectId: string;
    readonly integration: string;
    readonly slot: string;
    readonly instanceId: string | null;
  }) => Effect.Effect<ProjectDetail, AgentError>;
  readonly listTimers: (request: ListTimersRequest) => Effect.Effect<ReadonlyArray<TimerSummary>>;
  readonly cancelTimer: (request: CancelTimerRequest) => Effect.Effect<boolean>;
  readonly consents: (projectId?: string) => Effect.Effect<ReadonlyArray<ProjectConsentRequest>>;
  readonly approve: (consentId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly reject: (consentId: string, reason?: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly syncProject: (projectId: string) => Effect.Effect<void>;
  readonly syncAll: Effect.Effect<void>;
  readonly removeProject: (projectId: string) => Effect.Effect<void>;
  readonly resumeEnabled: () => Effect.Effect<void>;
  readonly running: () => Effect.Effect<ReadonlyArray<ActiveScript>>;
  readonly known: () => Effect.Effect<ReadonlyArray<ActiveScript>>;
  readonly closeAll: () => Effect.Effect<void>;
  readonly counts: Effect.Effect<{ readonly total: number; readonly running: number; readonly needsConsent: number; readonly error: number }>;
}

export class ProjectRuntime extends Context.Service<ProjectRuntime, ProjectRuntimeService>()(
  "ballast/service/ProjectRuntime",
) {}

const settingsPath = (path: Path.Path, project: ProjectRecord): string =>
  path.join(project.root, ".ballast", SETTINGS_FILE);
const appliedPath = (path: Path.Path, project: ProjectRecord): string =>
  path.join(project.root, ".ballast", APPLIED_FILE);
const bindingsPath = (path: Path.Path, project: ProjectRecord): string =>
  path.join(project.root, ".ballast", BINDINGS_FILE);
const toPosix = (path: Path.Path, value: string): string => value.split(path.sep).join("/");
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;
const paramValue = (value: unknown): ParamValue | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;

const readSettings = (
  project: ProjectRecord,
): Effect.Effect<SettingsState, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const value = yield* readJson(settingsPath(path, project)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (!isRecord(value)) return { enabled: false, params: {} };
  const params: Record<string, ParamValue> = {};
  const rawParams = value["params"];
  if (isRecord(rawParams)) {
    for (const [key, raw] of Object.entries(rawParams)) {
      const parsed = paramValue(raw);
      if (parsed !== undefined) params[key] = parsed;
    }
  }
  return { enabled: value["enabled"] === true, params };
  });

const isProjectManifest = (value: unknown): value is Manifest => {
  if (!isRecord(value) || !isRecord(value["project"])) return false;
  return (
    typeof value["project"]["id"] === "string" &&
    typeof value["project"]["entry"] === "string" &&
    Array.isArray(value["params"]) &&
    Array.isArray(value["connections"]) &&
    Array.isArray(value["topics"]) &&
    Array.isArray(value["requests"]) &&
    Array.isArray(value["unresolved"]) &&
    Array.isArray(value["timers"]) &&
    Array.isArray(value["workflows"]) &&
    Array.isArray(value["runs"])
  );
};

const readApplied = (
  project: ProjectRecord,
): Effect.Effect<AppliedFile | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const value = yield* readJson(appliedPath(path, project)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (!isRecord(value) || !isProjectManifest(value["manifest"])) return undefined;
  const appliedAt = value["appliedAt"];
  return { version: 1, manifest: value["manifest"], appliedAt: typeof appliedAt === "number" ? appliedAt : Date.now() };
  });

const readBindings = (
  project: ProjectRecord,
): Effect.Effect<
  Readonly<Record<string, string>>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const value = yield* readJson(bindingsPath(path, project)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (!isRecord(value) || !isRecord(value["bindings"])) return {};
  const bindings: Record<string, string> = {};
  for (const [key, instanceId] of Object.entries(value["bindings"])) {
    if (typeof instanceId === "string" && instanceId !== "") bindings[key] = instanceId;
  }
  return bindings;
  });

const walkProject = (
  root: string,
  directory: string,
  files: Array<string>,
  directories: Array<string>,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catch(() => Effect.succeed([] as Array<string>)),
  );
  entries.sort((left, right) => left.localeCompare(right));
  for (const name of entries) {
    if (name === "node_modules" || name === ".ballast" || name === "dist" || name === ".git") continue;
    const absolute = path.join(directory, name);
    const relativePath = toPosix(path, path.relative(root, absolute));
    const info = yield* fs.stat(absolute).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (info === undefined) continue;
    if (info.type === "Directory") {
      directories.push(relativePath);
      yield* walkProject(root, absolute, files, directories);
    } else if (info.type === "File") {
      files.push(relativePath);
    }
  }
  });

const projectFingerprint = (
  root: string,
): Effect.Effect<string, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const encoder = new TextEncoder();
    const files: Array<string> = [];
    const directories: Array<string> = [];
    yield* walkProject(root, root, files, directories);
    const parts: Array<Uint8Array> = [];
    for (const file of files) {
      parts.push(encoder.encode(file));
      parts.push(new Uint8Array([0]));
      parts.push(yield* fs.readFile(path.join(root, file)).pipe(Effect.orDie));
      parts.push(new Uint8Array([0]));
    }
    const combined = new Uint8Array(
      parts.reduce((total, part) => total + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    const digest = yield* crypto.digest("SHA-256", combined).pipe(Effect.orDie);
    return Hex.encode(digest);
  });

const unitKindOf = (manifest: Manifest, name: string): UnitSummary["kind"] | undefined => {
  if (manifest.topics.some((unit) => unit.name === name)) return "topic";
  if (manifest.timers.some((unit) => unit.name === name)) return "timer";
  if (manifest.workflows.some((unit) => unit.name === name)) return "workflow";
  if (manifest.params.some((unit) => unit.key === name)) return "param";
  if (manifest.runs.some((unit) => unit.name === name)) return "run";
  return undefined;
};

const fileLanguage = (path: string): ProjectFileContent["language"] => {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return "typescript";
  if (path.endsWith(".json")) return "json";
  return "text";
};

export const ProjectRuntimeLive = Layer.effect(
  ProjectRuntime,
  Effect.gen(function* () {
    const projects = yield* ProjectManager;
    const connections = yield* ConnectionManager;
    const logs = yield* Logs;
    const router = yield* EventRouter;
    const hub = yield* ServiceHub;
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const platform = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
    const clock = yield* Effect.clockWith((value) => Effect.succeed(value));
    const timers = yield* makeTimerManager({ clock, logs, hub });
    const state = yield* Ref.make<ReadonlyMap<string, ProjectRuntimeRecord>>(new Map());
    const semaphore = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();

    const records = (): Effect.Effect<ReadonlyArray<ProjectRuntimeRecord>> =>
      Effect.map(Ref.get(state), (map) => [...map.values()]);

    const getRecord = (projectId: string): Effect.Effect<ProjectRuntimeRecord | undefined> =>
      Effect.map(Ref.get(state), (map) => map.get(projectId));

    const setRecord = (record: ProjectRuntimeRecord): Effect.Effect<ProjectRuntimeRecord> =>
      Effect.gen(function* () {
        const next = { ...record, updatedAt: Date.now() };
        yield* Ref.update(state, (map) => {
          const copy = new Map(map);
          copy.set(record.project.id, next);
          return copy;
        });
        return next;
      });

    const saveSettings = (project: ProjectRecord, settings: SettingsState): Effect.Effect<void> =>
      provide(
        writeJsonAtomic(
          settingsPath(paths, project),
          { version: 1, enabled: settings.enabled, params: settings.params },
          0o600,
        ),
      ).pipe(Effect.ignore);

    const saveApplied = (project: ProjectRecord, manifest: Manifest, at: number): Effect.Effect<void> =>
      provide(
        writeJsonAtomic(
          appliedPath(paths, project),
          { version: 1, manifest, appliedAt: at },
          0o600,
        ),
      ).pipe(Effect.ignore);

    const saveBindings = (
      project: ProjectRecord,
      bindings: Readonly<Record<string, string>>,
    ): Effect.Effect<void> =>
      provide(
        writeJsonAtomic(bindingsPath(paths, project), { version: 1, bindings }, 0o600),
      ).pipe(Effect.ignore);

    const optionsFor = (
      record: ProjectRuntimeRecord,
      manifest: Manifest | undefined = record.manifest,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
      Effect.gen(function* () {
        const options = new Map<string, ReadonlyArray<string>>();
        if (manifest === undefined) return options;
        for (const param of manifest.params) {
          if (param.options === undefined) continue;
          const instanceId = record.bindings[param.options.integration + "/" + param.options.slot];
          if (instanceId === undefined) continue;
          const values = yield* connections
            .optionValues({ ...param.options, connectionId: instanceId })
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (values !== undefined) options.set(param.key, values);
        }
        return options;
      });

    const requirementsFor = (
      record: ProjectRuntimeRecord,
    ): Effect.Effect<ReadonlyArray<ProjectRequirement>> =>
      Effect.gen(function* () {
        const manifest = record.manifest;
        if (manifest === undefined) return [];
        const available = yield* connections.summaries();
        return manifest.connections.map((connection) => {
          const key = connection.integration + "/" + connection.slot;
          const requested = record.bindings[key];
          const instance = requested === undefined
            ? undefined
            : available.find((candidate) => candidate.id === requested);
          const candidates = available.filter(
            (candidate) => candidate.integration === connection.integration,
          );
          const proposed =
            instance === undefined && candidates.length === 1
              ? candidates[0]?.id
              : undefined;
          return {
            integration: connection.integration,
            slot: connection.slot,
            location: connection.location,
            ...(instance === undefined ? {} : { boundInstanceId: instance.id }),
            ...(proposed === undefined ? {} : { proposedInstanceId: proposed }),
          };
        });
      });

    const bindingsFor = (
      record: ProjectRuntimeRecord,
    ): Effect.Effect<ReadonlyMap<string, Binding>> =>
      Effect.gen(function* () {
        const map = new Map<string, Binding>();
        const available = yield* connections.summaries();
        for (const connection of record.manifest?.connections ?? []) {
          const instanceId = record.bindings[connection.integration + "/" + connection.slot];
          if (instanceId === undefined) continue;
          const instance = available.find((candidate) => candidate.id === instanceId);
          if (instance === undefined) continue;
          map.set(connection.integration + "/" + connection.slot, {
            id: instance.id,
            status: instance.status,
          });
        }
        return map;
      });

    const paramView = (param: ParamManifest, params: Readonly<Record<string, ParamValue>>, options: ReadonlyArray<string> | undefined): ParamView => {
      const value = params[param.key] ?? param.default;
      return {
        key: param.key,
        type: param.type,
        ...(param.title === undefined ? {} : { title: param.title }),
        ...(param.description === undefined ? {} : { description: param.description }),
        ...(param.source === undefined ? {} : { source: param.source }),
        ...(param.default === undefined ? {} : { default: param.default }),
        ...(value === undefined ? {} : { value }),
        required: param.default === undefined && params[param.key] === undefined,
        ...(options === undefined ? {} : { options }),
        ...(param.options === undefined ? {} : { optionsSource: { integration: param.options.integration, slot: param.options.slot, source: param.options.source } }),
        ...(param.default === undefined && params[param.key] === undefined ? { error: "A value is required" } : {}),
      };
    };

    const wireManifest = (manifest: Manifest, params: Readonly<Record<string, ParamValue>>, options: ReadonlyMap<string, ReadonlyArray<string>>, bound: ReadonlyMap<string, Binding>): ProjectManifest => ({
      project: manifest.project,
      params: manifest.params.map((param) => paramView(param, params, options.get(param.key))),
      connections: manifest.connections.map((connection) => {
        const binding = bound.get(connection.integration + "/" + connection.slot);
        return {
          integration: connection.integration,
          slot: connection.slot,
          location: connection.location,
          ...(binding === undefined ? {} : { connectionId: binding.id, connectionStatus: binding.status }),
        };
      }),
      topics: manifest.topics.map((topic) => ({
        name: topic.name,
        integration: topic.integration,
        slot: topic.slot,
        topic: topic.topic,
        scopes: [...topic.scopes],
        onStale: topic.onStale,
        maxAgeMs: topic.maxAgeMs,
        ...(topic.source === undefined ? {} : { source: topic.source }),
        ...(topic.condition === undefined ? {} : { condition: topic.condition }),
      })),
      requests: manifest.requests.map((request) => ({ integration: request.integration, slot: request.slot, request: request.request, scopes: [...request.scopes] })),
      timers: manifest.timers.map((timer) => ({
        name: timer.name,
        ...(timer.title === undefined ? {} : { title: timer.title }),
        onStale: timer.onStale,
        maxAgeMs: timer.maxAgeMs,
        payloadFingerprint: timer.payloadFingerprint,
        ...(timer.source === undefined ? {} : { source: timer.source }),
      })),
      workflows: manifest.workflows.map((workflow) => ({
        name: workflow.name,
        ...(workflow.title === undefined ? {} : { title: workflow.title }),
        fingerprint: workflow.fingerprint,
        ...(workflow.source === undefined ? {} : { source: workflow.source }),
      })),
      runs: manifest.runs.map((run) => ({ name: run.name, ...(run.source === undefined ? {} : { source: run.source }) })),
      unresolved: manifest.unresolved.map((entry) => ({ path: entry.path, reason: entry.reason })),
    });

    const wireDiff = (
      changes: ReturnType<typeof diffProject>["units"],
      options: ReadonlyMap<string, ReadonlyArray<string>>,
      bound: ReadonlyMap<string, Binding>,
      params: Readonly<Record<string, ParamValue>>,
    ): ManifestDiff => ({
      requiresConsent: changes.requiresConsent,
      added: {
        connections: changes.connections.added.map((connection) => {
          const binding = bound.get(connection.integration + "/" + connection.slot);
          return {
            integration: connection.integration,
            slot: connection.slot,
            location: connection.location,
            ...(binding === undefined
              ? {}
              : { connectionId: binding.id, connectionStatus: binding.status }),
          };
        }),
        topics: changes.topics.added.map((topic) => ({
          integration: topic.integration,
          slot: topic.slot,
          topic: topic.topic,
          scopes: [...topic.scopes],
          onStale: topic.onStale,
          maxAgeMs: topic.maxAgeMs,
          ...(topic.condition === undefined ? {} : { condition: topic.condition }),
        })),
        requests: changes.requests.added.map((request) => ({
          integration: request.integration,
          slot: request.slot,
          request: request.request,
          scopes: [...request.scopes],
        })),
        scopes: [...changes.scopes.added],
        params: changes.params.added.map((param) =>
          paramView(param, params, options.get(param.key)),
        ),
      },
      removed: {
        connections: changes.connections.removed.map((connection) => {
          const binding = bound.get(connection.integration + "/" + connection.slot);
          return {
            integration: connection.integration,
            slot: connection.slot,
            location: connection.location,
            ...(binding === undefined
              ? {}
              : { connectionId: binding.id, connectionStatus: binding.status }),
          };
        }),
        topics: changes.topics.removed.map((topic) => ({
          integration: topic.integration,
          slot: topic.slot,
          topic: topic.topic,
          scopes: [...topic.scopes],
          onStale: topic.onStale,
          maxAgeMs: topic.maxAgeMs,
          ...(topic.condition === undefined ? {} : { condition: topic.condition }),
        })),
        requests: changes.requests.removed.map((request) => ({
          integration: request.integration,
          slot: request.slot,
          request: request.request,
          scopes: [...request.scopes],
        })),
        scopes: [...changes.scopes.removed],
        params: changes.params.removed.map((param) =>
          paramView(param, params, options.get(param.key)),
        ),
      },
    });

    const units = (record: ProjectRuntimeRecord, timerRows: ReadonlyArray<TimerSummary>): ReadonlyArray<UnitSummary> => {
      const manifest = record.manifest;
      if (manifest === undefined) return [];
      const active = record.session !== undefined;
      const topicUnits: ReadonlyArray<UnitSummary> = manifest.topics.map((topic) => ({
        kind: "topic",
        name: topic.name,
        status: active ? "active" : "waiting",
        ...(topic.source === undefined ? {} : { source: topic.source }),
      }));
      const timerUnits: ReadonlyArray<UnitSummary> = manifest.timers.map((timer) => {
        const pending = timerRows.find((row) => row.timer === timer.name && row.state === "pending");
        return {
          kind: "timer",
          name: timer.name,
          ...(timer.title === undefined ? {} : { title: timer.title }),
          status: pending === undefined ? "waiting" : "active",
          ...(timer.source === undefined ? {} : { source: timer.source }),
          ...(pending === undefined ? {} : { lastActivityAt: pending.dueAt }),
        };
      });
      const workflowUnits: ReadonlyArray<UnitSummary> = manifest.workflows.map((workflow) => ({
        kind: "workflow",
        name: workflow.name,
        ...(workflow.title === undefined ? {} : { title: workflow.title }),
        status: "waiting",
        ...(workflow.source === undefined ? {} : { source: workflow.source }),
      }));
      const paramUnits: ReadonlyArray<UnitSummary> = manifest.params.map((param) => ({
        kind: "param",
        name: param.key,
        ...(param.title === undefined ? {} : { title: param.title }),
        status: "active",
        ...(param.source === undefined ? {} : { source: param.source }),
      }));
      const runUnits: ReadonlyArray<UnitSummary> = manifest.runs.map((run) => ({
        kind: "run",
        name: run.name,
        status: active ? "active" : "waiting",
        ...(run.source === undefined ? {} : { source: run.source }),
      }));
      return [...topicUnits, ...timerUnits, ...workflowUnits, ...paramUnits, ...runUnits];
    };

    const summaryOf = (record: ProjectRuntimeRecord): ProjectSummary => ({
      id: record.project.id,
      name: record.project.name,
      root: record.project.root,
      ...(record.entry === undefined ? {} : { entry: record.entry }),
      enabled: record.enabled,
      status: record.status,
      unitCount: record.manifest === undefined ? 0 : record.manifest.topics.length + record.manifest.timers.length + record.manifest.workflows.length + record.manifest.params.length + record.manifest.runs.length,
      createdAt: record.project.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    });

    const publish = (record: ProjectRuntimeRecord): Effect.Effect<void> =>
      hub.publish({ _tag: "project-changed", project: summaryOf(record) });


    const detailOf = (record: ProjectRuntimeRecord): Effect.Effect<ProjectDetail, AgentError> =>
      Effect.gen(function* () {
        const manifest = record.manifest ?? emptyManifest(record.project.id, record.entry ?? "ballast.ts");
        const options = yield* optionsFor(record);
        const bound = yield* bindingsFor(record);
        const requirements = yield* requirementsFor(record);
        const timerRows = yield* timers.list({ projectId: record.project.id });
        return {
          summary: summaryOf(record),
          manifest: wireManifest(manifest, record.params, options, bound),
          requirements,
          units: units(record, timerRows),
          ...(record.appliedAt === undefined ? {} : { appliedAt: record.appliedAt }),
          ...(record.pendingConsent === undefined ? {} : { pendingConsent: record.pendingConsent }),
          ...(record.lastErrorSource === undefined ? {} : { lastErrorSource: record.lastErrorSource }),
        };
      });

    const requireRecord = (projectId: string): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const record = yield* getRecord(projectId);
        if (record === undefined) return yield* Effect.fail(agentError("not-found", "No project " + projectId));
        return record;
      });

    const failureSource = (message: string): ProjectDetail["lastErrorSource"] => {
      const match = /^(.+?):(\d+):(\d+)\s+—/.exec(message);
      if (match === null) return undefined;
      const file = match[1];
      const line = match[2];
      const column = match[3];
      if (file === undefined || line === undefined || column === undefined) return undefined;
      return { file, line: Number(line), column: Number(column) };
    };

    const markFailure = (record: ProjectRuntimeRecord, message: string): Effect.Effect<ProjectRuntimeRecord> =>
      Effect.gen(function* () {
        const source = failureSource(message);
        const next = yield* setRecord({
          ...record,
          status: "error",
          lastError: message,
          lastErrorKind: "plan",
          lastErrorSource: source,
        });
        yield* hub.publish({
          _tag: "reload-failed",
          projectId: next.project.id,
          message,
          ...(next.lastErrorSource === undefined ? {} : { source: next.lastErrorSource }),
          at: Date.now(),
        });
        yield* publish(next);
        return next;
      });

    const markRuntimeFailure = (
      record: ProjectRuntimeRecord,
      message: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const next = yield* setRecord({
          ...record,
          status: "error",
          lastError: message,
          lastErrorKind: "runtime",
          lastErrorSource: failureSource(message),
        });
        yield* publish(next);
      });

    const startWithRuntimeErrors = (
      record: ProjectRuntimeRecord,
    ): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      startGeneration(record).pipe(
        Effect.tapError((error) => markRuntimeFailure(record, error.message)),
      );

    const ensureRecord = (project: ProjectRecord): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const existing = yield* getRecord(project.id);
        if (existing !== undefined) return existing;
        const settings = yield* provide(readSettings(project));
        const applied = yield* provide(readApplied(project));
        const bindings = yield* provide(readBindings(project));
        const record: ProjectRuntimeRecord = {
          project,
          entry: applied?.manifest.project.entry,
          entryFile: undefined,
          fingerprint: undefined,
          manifest: applied?.manifest,
          appliedManifest: applied?.manifest,
          appliedAt: applied?.appliedAt,
          status: "stopped",
          enabled: settings.enabled,
          generation: 0,
          updatedAt: project.updatedAt,
          lastError: undefined,
          lastErrorKind: undefined,
          lastErrorSource: undefined,
          pendingConsent: undefined,
          params: settings.params,
          bindings,
          session: undefined,
          activity: new Map(),
        };
        return yield* setRecord(record);
      });

    const consentOf = (record: ProjectRuntimeRecord, manifest: Manifest, resolvedEntry: string): Effect.Effect<ProjectConsentRequest> =>
      Effect.gen(function* () {
        const previous = record.appliedManifest ?? emptyManifest(record.project.id, resolvedEntry);
        const changes = diffProject(previous, manifest);
        const options = yield* optionsFor(record, manifest);
        const bound = yield* bindingsFor(record);
        const requirements = yield* requirementsFor({ ...record, manifest });
        const bindings: ReadonlyArray<ProjectBinding> = requirements.flatMap((requirement) => {
          const instanceId = requirement.boundInstanceId ?? requirement.proposedInstanceId;
          return instanceId === undefined
            ? []
            : [{ integration: requirement.integration, slot: requirement.slot, instanceId }];
        });
        const scopeChanges = changes.units.scopes.added;
        return {
          id: "consent_" + Hex.encode(yield* crypto.randomBytes(6).pipe(Effect.orDie)),
          projectId: record.project.id,
          projectName: record.project.name,
          createdAt: Date.now(),
          reason: scopeChanges.length > 0 ? "scopes" : "connections",
          summary: scopeChanges.length > 0 ? "Adds scopes: " + scopeChanges.join(", ") : "Adds connection slots",
          diff: wireDiff(changes.units, options, bound, record.params),
          bindings,
        };
      });

    const planAndApply = (record: ProjectRuntimeRecord, force: boolean): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const resolved = yield* resolveProjectEntry(record.project.root).pipe(Effect.mapError((error) => agentError("invalid", error.message)));
        const fingerprint = yield* provide(projectFingerprint(record.project.root));
        if (!force && record.fingerprint === fingerprint && record.manifest !== undefined) {
          if (record.status !== "error") return record;
          // Runtime errors belong to a start/restart attempt, not to a stale
          // plan. A file sync must not clear them without another start.
          if (record.lastErrorKind === "runtime") return record;
          const recovered = yield* setRecord({
            ...record,
            status: record.session === undefined ? "stopped" : "running",
            lastError: undefined,
            lastErrorKind: undefined,
            lastErrorSource: undefined,
          });
          yield* publish(recovered);
          return recovered;
        }
        const planned = yield* planProject(record.project.root, { projectId: record.project.id }).pipe(
          Effect.mapError((error) => agentError("invalid", error.message)),
        );
        const previous = record.appliedManifest ?? emptyManifest(record.project.id, resolved.entry);
        const changes = diffProject(previous, planned.manifest);
        const base: ProjectRuntimeRecord = { ...record, entry: resolved.entry, entryFile: resolved.entryFile, fingerprint, manifest: planned.manifest };
        if (changes.requiresConsent) {
          const consent = yield* consentOf(base, planned.manifest, resolved.entry);
          const next = yield* setRecord({ ...base, status: record.session === undefined ? "stopped" : "needs-consent", pendingConsent: consent });
          yield* hub.publish({ _tag: "project-consent", consent });
          yield* publish(next);
          return next;
        }
        const appliedAt = Date.now();
        yield* saveApplied(record.project, planned.manifest, appliedAt);
        const next = yield* setRecord({ ...base, appliedManifest: planned.manifest, appliedAt, pendingConsent: undefined, status: record.session === undefined ? "stopped" : "running", lastError: undefined, lastErrorKind: undefined, lastErrorSource: undefined });
        yield* publish(next);
        return next;
      }).pipe(
        Effect.tapError((error) => markFailure(record, error.message).pipe(Effect.asVoid)),
      );

    const confirmBindings = (
      record: ProjectRuntimeRecord,
      explicit?: ReadonlyArray<ProjectBinding>,
    ): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const requirements = yield* requirementsFor(record);
        const bindings = { ...record.bindings };
        if (explicit !== undefined) {
          for (const binding of explicit) {
            bindings[binding.integration + "/" + binding.slot] = binding.instanceId;
          }
        } else {
          for (const requirement of requirements) {
            if (requirement.boundInstanceId !== undefined) continue;
            if (requirement.proposedInstanceId === undefined) continue;
            bindings[requirement.integration + "/" + requirement.slot] =
              requirement.proposedInstanceId;
          }
        }
        yield* saveBindings(record.project, bindings);
        const next = yield* setRecord({ ...record, bindings });
        const remaining = yield* requirementsFor(next);
        const missing = remaining.filter(
          (requirement) => requirement.boundInstanceId === undefined,
        );
        if (missing.length > 0) {
          return yield* Effect.fail(
            agentError(
              "conflict",
              "The project has unbound connections: " +
                missing
                  .map((requirement) => requirement.integration + "/" + requirement.slot)
                  .join(", "),
              { missing },
            ),
          );
        }
        return next;
      });

    const requestHandler = (
      record: ProjectRuntimeRecord,
      requirements: ReadonlyArray<ProjectRequirement>,
    ) => (integration: string, request: string, slot: string, input: unknown): Effect.Effect<unknown, string> =>
      Effect.gen(function* () {
        yield* router.recordOutbound({ projectId: record.project.id, scriptId: record.entry ?? "", integration, slot, request, input });
        const instanceId = requirements.find(
          (requirement) => requirement.integration === integration && requirement.slot === slot,
        )?.boundInstanceId;
        return yield* connections.request({
          integration,
          slot,
          ...(instanceId === undefined ? {} : { connectionId: instanceId }),
          request,
          input,
        });
      });

    const reconcile = (
      include: ReadonlyArray<ProjectRuntimeRecord>,
      starting?: ProjectRuntimeRecord,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const all = [
          ...(yield* records()),
          ...include,
          ...(starting === undefined ? [] : [starting]),
        ];
        const running: Array<ActiveScript> = all.flatMap((record) => {
          const manifest = record.appliedManifest ?? record.manifest;
          return !record.enabled || manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest, enabled: record.enabled }];
        });

        const known: Array<ActiveScript> = all.flatMap((record) => {
          const manifest = record.manifest ?? record.appliedManifest;
          return manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest, enabled: record.enabled }];
        });

        const bindings = new Map<string, ReadonlyMap<string, string>>();
        for (const record of all) {
          bindings.set(record.project.id, new Map(Object.entries(record.bindings)));
        }
        yield* connections.reconcile({ running, known, bindings });
      });


    const startGeneration = (record: ProjectRuntimeRecord): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const manifest = record.appliedManifest ?? record.manifest;
        if (manifest === undefined || record.entryFile === undefined || record.entry === undefined) {
          return yield* Effect.fail(agentError("invalid", "The project has no applied manifest; plan it first"));
        }
        const generation = record.generation + 1;
        const previous = record.session;
        const requirements = yield* requirementsFor(record);
        const missing = requirements.filter(
          (requirement) => requirement.boundInstanceId === undefined,
        );
        if (missing.length > 0) {
          return yield* Effect.fail(
            agentError(
              "conflict",
              "The project has unbound connections: " +
                missing
                  .map((requirement) => requirement.integration + "/" + requirement.slot)
                  .join(", "),
              { missing },
            ),
          );
        }
        const bindingMap = new Map(
          requirements.flatMap((requirement) =>
            requirement.boundInstanceId === undefined
              ? []
              : [[requirement.integration + "/" + requirement.slot, requirement.boundInstanceId] as const],
          ),
        );
        yield* router.expectSubscriptions({
          projectId: record.project.id,
          scriptId: record.entry,
          subscriptions: manifest.topics.map((topic) => topic.integration + "/" + topic.slot + "/" + topic.topic),
          bindings: bindingMap,
        });
        yield* reconcile([], record);
        yield* connections.ready(
          requirements.flatMap((requirement) =>
            requirement.boundInstanceId === undefined
              ? []
              : [requirement.boundInstanceId],
          ),
        );
        const bundle = yield* provide(bundleScript(record.entryFile, generation)).pipe(
          Effect.mapError((error) => agentError("internal", error.message)),
        );
        const timerDeclaration = (name: string): TimerManifest | undefined => manifest.timers.find((timer) => timer.name === name);
        const session = yield* startRuntimeSession({
          bundlePath: bundle.path,
          generation,
          settings: { get: (key) => record.params[key] },
          request: requestHandler(record, requirements),
          registerTimer: (name) => timerDeclaration(name) === undefined ? Effect.die(new Error("Timer " + name + " is not declared")) : timers.registerName({ projectId: record.project.id, generation, name }),
          scheduleTimer: (input) => {
            const declaration = timerDeclaration(input.name);
            if (declaration === undefined) return Effect.fail("Timer " + input.name + " is not declared");
            return timers.schedule({ projectId: record.project.id, generation, declaration, manifest, key: input.key, delayMs: input.delayMs, payload: input.payload });
          },
          cancelTimer: (input) => Effect.asVoid(timers.cancel({ projectId: record.project.id, timer: input.name, key: input.key })),
          onLog: (line) => {
            const kind = line.unitName === undefined ? undefined : unitKindOf(manifest, line.unitName);
            Effect.runForkWith(context)(logs.write({
              level: line.level,
              source: "worker",
              projectId: record.project.id,
              ...(line.unitName === undefined ? {} : { unitName: line.unitName }),
              ...(kind === undefined ? {} : { unitKind: kind }),
              message: line.message,
            }).pipe(Effect.andThen(Effect.sync(() => {
              const prefix = "[" + record.project.name + "]";
              if (line.level === "error") console.error(prefix + " " + line.message);
              else console.log(prefix + " " + line.message);
            }))));
          },
        }).pipe(
          Effect.mapError((error) => agentError("internal", error.message)),
          Effect.onError(() => Effect.gen(function* () {
            yield* router.cancelExpected({ projectId: record.project.id, scriptId: record.entry ?? "" });
            yield* timers.deactivate({ projectId: record.project.id, generation });
          })),
        );
        yield* router.register({
          projectId: record.project.id,
          scriptId: record.entry,
          session,
          bindings: bindingMap,
          unitNames: new Map(
            manifest.topics.map((topic) => [
              topic.integration + "/" + topic.slot + "/" + topic.topic,
              topic.name,
            ]),
          ),
        });
        yield* timers.activate({ projectId: record.project.id, generation, session, manifest });
        const next = yield* setRecord({ ...record, appliedManifest: manifest, manifest, generation, status: "running", lastError: undefined, lastErrorKind: undefined, lastErrorSource: undefined, pendingConsent: undefined, session });
        if (previous !== undefined && previous !== session) {
          Effect.runForkWith(context)(Effect.sleep("30 seconds").pipe(Effect.andThen(previous.close), Effect.catchCause(() => Effect.void)));
        }
        yield* logs.write({ level: "info", source: "agent", projectId: next.project.id, message: "started project generation " + generation });
        yield* publish(next);
        return next;
      });

    const stopGeneration = (record: ProjectRuntimeRecord, enabled: boolean): Effect.Effect<ProjectRuntimeRecord> =>
      Effect.gen(function* () {
        if (record.entry !== undefined) {
          yield* timers.deactivate({ projectId: record.project.id, generation: record.generation });
          yield* router.unregister(record.project.id);
        }
        if (record.session !== undefined) yield* record.session.close;
        const next = yield* setRecord({ ...record, enabled, status: "stopped", session: undefined });
        yield* publish(next);
        yield* reconcile([]);
        return next;
      });

    const saveEnabled = (record: ProjectRuntimeRecord, enabled: boolean): Effect.Effect<void> =>
      saveSettings(record.project, { enabled, params: record.params });

    const start = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const initial = yield* requireRecord(projectId);
        yield* saveEnabled(initial, true);
        const enabled = yield* setRecord({ ...initial, enabled: true });
        const record = yield* planAndApply(enabled, false);
        return yield* Effect.gen(function* () {
          const confirmed = yield* confirmBindings(record);
          if (confirmed.pendingConsent !== undefined) return yield* detailOf(confirmed);
          if (confirmed.session !== undefined && confirmed.status === "running") {
            return yield* detailOf(confirmed);
          }
          return yield* detailOf(yield* startGeneration(confirmed));
        }).pipe(
          Effect.tapError((error) =>
            markRuntimeFailure(record, error.message).pipe(Effect.asVoid),
          ),
        );
      }));

    const stop = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        yield* saveEnabled(record, false);
        const next = yield* stopGeneration({ ...record, enabled: false }, false);
        return yield* detailOf(next);
      }));

    const plan = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const next = yield* planAndApply(record, true);
        return yield* detailOf(next);
      }));

    const diagnosticOf = (message: string): { code: string; message: string } => {
      const match = /^(TS\d+):\s+(.*)$/.exec(message);
      if (match === null) return { code: "TS", message };
      const code = match[1];
      const text = match[2];
      return code === undefined || text === undefined ? { code: "TS", message } : { code, message: text };
    };

    const check = (projectId: string): Effect.Effect<ProjectCheckResult, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const options = yield* optionsFor(record);
        const bound = yield* bindingsFor(record);
        const requirements = yield* requirementsFor(record);
        const availableConnections = yield* connections.summaries();
        const applied = record.appliedManifest;
        const appliedManifest =
          applied === undefined ? undefined : wireManifest(applied, record.params, options, bound);
        const resolved = yield* resolveProjectEntry(record.project.root).pipe(Effect.exit);
        if (Exit.isFailure(resolved)) {
          const failure = Cause.squash(resolved.cause);
          const message = typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string" ? failure.message : String(failure);
          return {
            summary: summaryOf(record),
            ok: false,
            units: [],
            changes: [],
            requiresConsent: false,
            requirements,
            missingConnections: requirements.filter(
              (requirement) => requirement.boundInstanceId === undefined,
            ),
            missingScopes: [],
            availableConnections,
            ...(record.pendingConsent === undefined ? {} : { pendingConsent: record.pendingConsent }),
            ...(appliedManifest === undefined ? {} : { appliedManifest }),
            diagnostics: [],
            error: message,
          };
        }
        const planned = yield* planProject(record.project.root, { projectId: record.project.id }).pipe(Effect.exit);
        if (Exit.isFailure(planned)) {
          const failure = Cause.squash(planned.cause);
          const diagnostics: ReadonlyArray<ProjectDiagnostic> =
            typeof failure === "object" && failure !== null && "diagnostics" in failure && Array.isArray(failure.diagnostics)
              ? failure.diagnostics.flatMap((diagnostic: unknown) => {
                  if (
                    typeof diagnostic !== "object" ||
                    diagnostic === null ||
                    !("file" in diagnostic) ||
                    !("line" in diagnostic) ||
                    !("column" in diagnostic) ||
                    !("message" in diagnostic) ||
                    typeof diagnostic.file !== "string" ||
                    typeof diagnostic.line !== "number" ||
                    typeof diagnostic.column !== "number" ||
                    typeof diagnostic.message !== "string"
                  ) {
                    return [];
                  }
                  const parsed = diagnosticOf(diagnostic.message);
                  return [{
                    file: diagnostic.file,
                    line: diagnostic.line,
                    column: diagnostic.column,
                    code: parsed.code,
                    message: parsed.message,
                  }];
                })
              : [];
          const message =
            typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string"
              ? failure.message
              : String(failure);
          return {
            summary: summaryOf(record),
            ok: false,
            units: [],
            changes: [],
            requiresConsent: false,
            requirements,
            missingConnections: requirements.filter(
              (requirement) => requirement.boundInstanceId === undefined,
            ),
            missingScopes: [],
            availableConnections,
            ...(record.pendingConsent === undefined ? {} : { pendingConsent: record.pendingConsent }),
            ...(appliedManifest === undefined ? {} : { appliedManifest }),
            diagnostics,
            error: message,
          };
        }
        const next = planned.value;
        const previous = applied ?? emptyManifest(record.project.id, next.entry.entry);
        const diff = diffProject(previous, next.manifest);
        const changes: ReadonlyArray<ProjectUnitChange> = diff.changes.map((change) => ({
          kind: change.kind,
          name: change.name,
          change: change.change,
          ...(change.before === undefined ? {} : { before: change.before }),
          ...(change.after === undefined ? {} : { after: change.after }),
          ...(change.source === undefined ? {} : { source: change.source }),
        }));
        const plannedRecord: ProjectRuntimeRecord = { ...record, manifest: next.manifest };
        const plannedRequirements = yield* requirementsFor(plannedRecord);
        const plannedBound = yield* bindingsFor(plannedRecord);
        const plannedOptions = yield* optionsFor(plannedRecord);
        const missingConnections = plannedRequirements.filter(
          (requirement) => requirement.boundInstanceId === undefined,
        );
        const cleared =
          record.lastErrorKind === "plan"
            ? yield* setRecord({
                ...record,
                status: record.session === undefined ? "stopped" : "running",
                lastError: undefined,
                lastErrorKind: undefined,
                lastErrorSource: undefined,
              })
            : record;
        const checked: ProjectRuntimeRecord = { ...cleared, manifest: next.manifest, entry: next.entry.entry, entryFile: next.entry.entryFile };
        return {
          summary: summaryOf(checked),
          ok: true,
          manifest: wireManifest(next.manifest, record.params, plannedOptions, plannedBound),
          ...(appliedManifest === undefined ? {} : { appliedManifest }),
          units: units(checked, []),
          changes,
          requiresConsent: diff.requiresConsent,
          requirements: plannedRequirements,
          missingConnections,
          missingScopes: [...diff.units.scopes.added],
          availableConnections,
          ...(record.pendingConsent === undefined ? {} : { pendingConsent: record.pendingConsent }),
          diagnostics: [],
        };
      }));

    const restart = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const stopped = record.session === undefined ? record : yield* stopGeneration(record, true);
        const next = yield* planAndApply({ ...stopped, enabled: true }, true);
        const started = next.session === undefined ? yield* startWithRuntimeErrors({ ...next, enabled: true }) : next;
        yield* saveEnabled(started, true);
        return yield* detailOf(started);
      }));


    const setParam = (projectId: string, key: string, value: ParamValue): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const manifest = record.manifest;
        if (manifest === undefined) return yield* Effect.fail(agentError("invalid", "The project has no manifest yet"));
        const param = manifest.params.find((candidate) => candidate.key === key);
        if (param === undefined) return yield* Effect.fail(agentError("invalid", "The project has no param " + key));
        const valid =
          (param.type === "string" && typeof value === "string") ||
          (param.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
          (param.type === "boolean" && typeof value === "boolean") ||
          (param.type === "enum" && typeof value === "string") ||
          (param.type === "strings" &&
            Array.isArray(value) &&
            value.every((entry) => typeof entry === "string"));
        if (!valid) return yield* Effect.fail(agentError("invalid", "Param " + key + " expects a " + param.type + " value"));
        if ((param.type === "enum" || param.type === "strings") && param.options !== undefined) {
          const instanceId =
            record.bindings[param.options.integration + "/" + param.options.slot];
          const options =
            instanceId === undefined
              ? undefined
              : yield* connections
                  .optionValues({ ...param.options, connectionId: instanceId })
                  .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (options !== undefined) {
            const selected =
              param.type === "strings" && Array.isArray(value)
                ? value.filter((entry): entry is string => typeof entry === "string")
                : typeof value === "string"
                  ? [value]
                  : [];
            const rejected = selected.filter((entry) => !options.includes(entry));
            if (rejected.length > 0) {
              return yield* Effect.fail(
                agentError(
                  "invalid",
                  "Param " + key + " must be one of: " + options.join(", "),
                ),
              );
            }
          }
        }
        const params = { ...record.params, [key]: value };
        yield* saveSettings(record.project, { enabled: record.enabled, params });
        const next = yield* setRecord({ ...record, params });
        if (next.session !== undefined) {
          const restarted = yield* startWithRuntimeErrors(next);
          return yield* detailOf(restarted);
        }
        return yield* detailOf(next);
      }));

    const setEnabled = (projectId: string, enabled: boolean): Effect.Effect<ProjectDetail, AgentError> => enabled ? start(projectId) : stop(projectId);

    const setBinding = (request: {
      readonly projectId: string;
      readonly integration: string;
      readonly slot: string;
      readonly instanceId: string | null;
    }): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(request.projectId);
        const manifest = record.manifest ?? record.appliedManifest;
        if (manifest === undefined) {
          return yield* Effect.fail(agentError("invalid", "The project has no manifest yet"));
        }
        const requirement = manifest.connections.find(
          (connection) =>
            connection.integration === request.integration &&
            connection.slot === request.slot,
        );
        if (requirement === undefined) {
          return yield* Effect.fail(
            agentError(
              "invalid",
              "The project has no connection requirement " +
                request.integration +
                "/" +
                request.slot,
            ),
          );
        }
        if (request.instanceId !== null) {
          const instance = yield* connections.summary(request.instanceId);
          if (instance === undefined) {
            return yield* Effect.fail(
              agentError("not-found", "No connection instance " + request.instanceId),
            );
          }
          if (instance.integration !== request.integration) {
            return yield* Effect.fail(
              agentError(
                "invalid",
                "Connection " + instance.id + " is " + instance.integration +
                  ", not " + request.integration,
              ),
            );
          }
        }
        const key = request.integration + "/" + request.slot;
        const bindings = { ...record.bindings };
        if (request.instanceId === null) delete bindings[key];
        else bindings[key] = request.instanceId;
        yield* saveBindings(record.project, bindings);
        const next = yield* setRecord({ ...record, bindings });
        if (record.session !== undefined) {
          if (request.instanceId === null) {
            yield* saveEnabled(next, false);
            const stopped = yield* stopGeneration({ ...next, enabled: false }, false);
            return yield* detailOf(stopped);
          }
          const restarted = yield* startWithRuntimeErrors(next);
          yield* publish(restarted);
          return yield* detailOf(restarted);
        }
        yield* reconcile([]);
        yield* publish(next);
        return yield* detailOf(next);
      }));

    const files = (projectId: string): Effect.Effect<{ readonly entry: string; readonly files: ReadonlyArray<ProjectFile> }, AgentError> =>
      Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const filePaths: Array<string> = [];
        const directories: Array<string> = [];
        yield* provide(
          walkProject(record.project.root, record.project.root, filePaths, directories),
        );
        const all: Array<ProjectFile> = [
          ...directories.map((path) => ({ path, kind: "directory" as const })),
          ...filePaths.map((path) => ({ path, kind: "file" as const })),
        ].sort((left, right) => left.path.localeCompare(right.path));
        return { entry: record.entry ?? "ballast.ts", files: all };
      });

    const readFileAt = (projectId: string, path: string): Effect.Effect<ProjectFileContent, AgentError> =>
      Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const root = paths.resolve(record.project.root);
        const absolute = paths.resolve(root, path);
        const relativePath = paths.relative(root, absolute);
        const segments = relativePath.split(paths.sep);
        if (relativePath === "" || relativePath.startsWith("..") || segments.includes(".ballast") || segments.includes("node_modules")) {
          return yield* Effect.fail(agentError("invalid", "File " + path + " is outside the project"));
        }
        const info = yield* provide(fs.stat(absolute)).pipe(
          Effect.mapError(() => agentError("not-found", "No file " + path)),
        );
        if (info.type !== "File") {
          return yield* Effect.fail(agentError("invalid", path + " is not a file"));
        }
        const content = yield* provide(fs.readFileString(absolute)).pipe(
          Effect.mapError((cause) => agentError("internal", cause.message)),
        );
        return {
          path: toPosix(paths, relativePath),
          content,
          sha256: yield* provide(contentHash(content)).pipe(Effect.orDie),
          updatedAt: Option.getOrElse(info.mtime, () => new Date()).getTime(),
          language: fileLanguage(path),
        };
      });

    const summaries = (): Effect.Effect<ReadonlyArray<ProjectSummary>> =>
      Effect.map(records(), (all) => all.map(summaryOf).sort((left, right) => left.name.localeCompare(right.name)));

    const summary = (projectId: string): Effect.Effect<ProjectSummary | undefined> =>
      Effect.map(getRecord(projectId), (record) => record === undefined ? undefined : summaryOf(record));

    const syncProject = (projectId: string): Effect.Effect<void> =>
      semaphore.withPermit(Effect.gen(function* () {
        const project = yield* projects.get(projectId);
        if (project === undefined) return;
        const entry = yield* resolveProjectEntry(project.root).pipe(Effect.exit);
        if (Exit.isFailure(entry)) {
          const existing = yield* getRecord(projectId);
          if (existing !== undefined) yield* markFailure(existing, String(entry.cause)).pipe(Effect.asVoid);
          return;
        }
        yield* timers.loadProject({ id: project.id, root: project.root });
        const record = yield* ensureRecord(project);
        const fingerprint = yield* provide(projectFingerprint(project.root));
        const planned = yield* planAndApply(
          record,
          fingerprint !== record.fingerprint,
        ).pipe(Effect.exit);
        if (Exit.isFailure(planned)) {
          const failure = Cause.squash(planned.cause);
          const message =
            typeof failure === "object" &&
            failure !== null &&
            "message" in failure &&
            typeof failure.message === "string"
              ? failure.message
              : String(failure);
          yield* markFailure(record, message).pipe(Effect.asVoid);
          return;
        }
        const next = planned.value;
        if (
          next.enabled &&
          record.session !== undefined &&
          next.pendingConsent === undefined &&
          next.fingerprint !== record.fingerprint &&
          next.fingerprint === fingerprint
        ) {
          yield* startGeneration(next).pipe(
            Effect.catchCause(() => Effect.void),
          );
        }
      })).pipe(Effect.catch(() => Effect.void));

    const syncAll: Effect.Effect<void> = Effect.gen(function* () {
      for (const project of yield* projects.projects) {
        yield* syncProject(project.id).pipe(Effect.catchCause(() => Effect.void));
      }
      yield* reconcile([]).pipe(Effect.catchCause(() => Effect.void));
    });

    const counts = Effect.map(records(), (all) => ({
      total: all.length,
      running: all.filter((record) => record.status === "running").length,
      needsConsent: all.filter((record) => record.pendingConsent !== undefined).length,
      error: all.filter((record) => record.status === "error").length,
    }));

    const resumeEnabled = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const record of yield* records()) {
          if (!record.enabled || record.session !== undefined) continue;
          const manifest = record.manifest ?? record.appliedManifest;
          const scriptId = record.entry ?? manifest?.project.entry;
          if (manifest !== undefined && scriptId !== undefined) {
            const bindings = new Map(
              manifest.connections.flatMap((connection) => {
                const key = connection.integration + "/" + connection.slot;
                const instanceId = record.bindings[key];
                return instanceId === undefined
                  ? []
                  : ([[key, instanceId]] as const);
              }),
            );
            yield* router.expectSubscriptions({
              projectId: record.project.id,
              scriptId,
              subscriptions: manifest.topics.map(
                (topic) =>
                  topic.integration + "/" + topic.slot + "/" + topic.topic,
              ),
              bindings,
            });
          }
          yield* start(record.project.id).pipe(Effect.catchCause(() => Effect.void));
        }
      });

    const removeProject = (projectId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = yield* getRecord(projectId);
        if (record !== undefined) {
          yield* stopGeneration(record, false);
          yield* timers.removeProject(projectId);
          yield* provide(
            fs.remove(paths.join(record.project.root, ".ballast"), {
              recursive: true,
              force: true,
            }),
          ).pipe(Effect.ignore);
        }
        yield* Ref.update(state, (map) => {
          if (!map.has(projectId)) return map;
          const next = new Map(map);
          next.delete(projectId);
          return next;
        });
      });

    const running = (): Effect.Effect<ReadonlyArray<ActiveScript>> =>
      Effect.map(records(), (all) => all.flatMap((record) => !record.enabled || record.manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest: record.manifest, enabled: record.enabled }]));

    const known = (): Effect.Effect<ReadonlyArray<ActiveScript>> =>
      Effect.map(records(), (all) => all.flatMap((record) => record.manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest: record.manifest, enabled: record.enabled }]));

    const closeAll = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const record of yield* records()) {
          if (record.entry !== undefined) yield* timers.deactivate({ projectId: record.project.id, generation: record.generation });
          if (record.session !== undefined) yield* record.session.close;
        }
      });

    return {
      summaries,
      summary,
      detail: (projectId) => Effect.flatMap(requireRecord(projectId), detailOf),
      files,
      readFile: readFileAt,
      entrySource: (projectId) => Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        return yield* readFileAt(projectId, record.entry ?? "ballast.ts");
      }),
      plan,
      check,
      start,
      stop,
      restart,
      setParam,
      setEnabled,
      setBinding,
      listTimers: (request) => timers.list(request),
      cancelTimer: (request) => timers.cancel({ projectId: request.projectId, scriptId: request.scriptId ?? "", timer: request.timer, key: request.key }),
      consents: (projectId) => Effect.map(records(), (all) => all.flatMap((record) => record.pendingConsent === undefined || (projectId !== undefined && record.project.id !== projectId) ? [] : [record.pendingConsent])),
      approve: (consentId) =>
        semaphore.withPermit(Effect.gen(function* () {
          const record = (yield* records()).find((candidate) => candidate.pendingConsent?.id === consentId);
          if (record === undefined) return yield* Effect.fail(agentError("not-found", "No pending consent " + consentId));
          const manifest = record.manifest;
          if (manifest === undefined) return yield* Effect.fail(agentError("invalid", "The project has no planned manifest"));
          const appliedAt = Date.now();
          yield* saveApplied(record.project, manifest, appliedAt);
          const confirmed = yield* confirmBindings(
            {
              ...record,
              appliedManifest: manifest,
              appliedAt,
              pendingConsent: undefined,
              status: record.session === undefined ? "stopped" : "running",
            },
            record.pendingConsent?.bindings ?? [],
          );
          const next = yield* setRecord(confirmed);
          const started = next.enabled && next.session === undefined ? yield* startWithRuntimeErrors(next) : next;
          yield* hub.publish({ _tag: "project-consent-resolved", projectId: started.project.id, consentId, approved: true, project: summaryOf(started) });
          return yield* detailOf(started);
        })),
      reject: (consentId, _reason) =>
        semaphore.withPermit(Effect.gen(function* () {
          const record = (yield* records()).find((candidate) => candidate.pendingConsent?.id === consentId);
          if (record === undefined) return yield* Effect.fail(agentError("not-found", "No pending consent " + consentId));
          const next = yield* setRecord({ ...record, pendingConsent: undefined, status: record.session === undefined ? "stopped" : "running" });
          yield* hub.publish({ _tag: "project-consent-resolved", projectId: next.project.id, consentId, approved: false, project: summaryOf(next) });
          yield* publish(next);
          return yield* detailOf(next);
        })),
      syncProject,
      syncAll,
      removeProject,
      resumeEnabled,
      running,
      known,
      closeAll,
      counts,
    };
  }),
);
