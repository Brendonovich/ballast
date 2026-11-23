import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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
  type ParamValue,
  type ParamView,
  type ProjectCheckResult,
  type ProjectConsentRequest,
  type ProjectDetail,
  type ProjectDiagnostic,
  type ProjectFile,
  type ProjectFileContent,
  type ProjectManifest,
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
import { ScriptManager } from "./scripts.ts";
import { toWireDiff } from "./scripts.ts";
import { EventRouter, Logs, ServiceHub } from "./telemetry.ts";
import { makeTimerManager } from "./timers.ts";

const SETTINGS_FILE = "settings.json";
const APPLIED_FILE = "applied.json";

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
  readonly lastErrorSource: ProjectDetail["lastErrorSource"];
  readonly pendingConsent: ProjectConsentRequest | undefined;
  readonly params: Readonly<Record<string, ParamValue>>;
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

const settingsPath = (project: ProjectRecord): string => join(project.root, ".ballast", SETTINGS_FILE);
const appliedPath = (project: ProjectRecord): string => join(project.root, ".ballast", APPLIED_FILE);
const toPosix = (value: string): string => value.split(sep).join("/");
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;
const paramValue = (value: unknown): ParamValue | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;

const readSettings = async (project: ProjectRecord): Promise<SettingsState> => {
  const value = await readJson(settingsPath(project));
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
};

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

const readApplied = async (project: ProjectRecord): Promise<AppliedFile | undefined> => {
  const value = await readJson(appliedPath(project));
  if (!isRecord(value) || !isProjectManifest(value["manifest"])) return undefined;
  const appliedAt = value["appliedAt"];
  return { version: 1, manifest: value["manifest"], appliedAt: typeof appliedAt === "number" ? appliedAt : Date.now() };
};

const walkProject = async (root: string, directory: string, files: Array<string>, directories: Array<string>): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".ballast" || entry.name === "dist" || entry.name === ".git") continue;
    const absolute = join(directory, entry.name);
    const path = toPosix(relative(root, absolute));
    if (entry.isDirectory()) {
      directories.push(path);
      await walkProject(root, absolute, files, directories);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
};

const projectFingerprint = async (root: string): Promise<string> => {
  const files: Array<string> = [];
  const directories: Array<string> = [];
  await walkProject(root, root, files, directories);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\u0000");
    hash.update(await readFile(join(root, path)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
};

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
    const scripts = yield* ScriptManager;
    const connections = yield* ConnectionManager;
    const logs = yield* Logs;
    const router = yield* EventRouter;
    const hub = yield* ServiceHub;
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
      Effect.tryPromise({
        try: () => writeJsonAtomic(settingsPath(project), { version: 1, enabled: settings.enabled, params: settings.params }, 0o600),
        catch: () => undefined,
      }).pipe(Effect.ignore);

    const saveApplied = (project: ProjectRecord, manifest: Manifest, at: number): Effect.Effect<void> =>
      Effect.tryPromise({
        try: () => writeJsonAtomic(appliedPath(project), { version: 1, manifest, appliedAt: at }, 0o600),
        catch: () => undefined,
      }).pipe(Effect.ignore);

    const optionsFor = (manifest: Manifest | undefined): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
      Effect.gen(function* () {
        const options = new Map<string, ReadonlyArray<string>>();
        if (manifest === undefined) return options;
        for (const param of manifest.params) {
          if (param.options === undefined) continue;
          const values = yield* connections.optionValues(param.options).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (values !== undefined) options.set(param.key, values);
        }
        return options;
      });

    const bindings = (): Effect.Effect<ReadonlyMap<string, Binding>> =>
      Effect.gen(function* () {
        const map = new Map<string, Binding>();
        for (const connection of yield* connections.summaries()) {
          map.set(connection.integration + "/" + connection.slot, { id: connection.id, status: connection.status });
        }
        return map;
      });

    const paramView = (param: ParamManifest, params: Readonly<Record<string, ParamValue>>, options: ReadonlyArray<string> | undefined): ParamView => {
      const value = params[param.key] ?? param.default;
      return {
        key: param.key,
        type: param.type,
        ...(param.title === undefined ? {} : { title: param.title }),
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
        const options = yield* optionsFor(record.manifest);
        const bound = yield* bindings();
        const timerRows = yield* timers.list({ projectId: record.project.id });
        return {
          summary: summaryOf(record),
          manifest: wireManifest(manifest, record.params, options, bound),
          units: units(record, timerRows),
          scripts: [],
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
        const next = yield* setRecord({ ...record, status: "error", lastError: message, lastErrorSource: source });
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

    const ensureRecord = (project: ProjectRecord): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const existing = yield* getRecord(project.id);
        if (existing !== undefined) return existing;
        const settings = yield* Effect.promise(() => readSettings(project));
        const applied = yield* Effect.promise(() => readApplied(project));
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
          lastErrorSource: undefined,
          pendingConsent: undefined,
          params: settings.params,
          session: undefined,
          activity: new Map(),
        };
        return yield* setRecord(record);
      });

    const consentOf = (record: ProjectRuntimeRecord, manifest: Manifest, resolvedEntry: string): Effect.Effect<ProjectConsentRequest> =>
      Effect.gen(function* () {
        const previous = record.appliedManifest ?? emptyManifest(record.project.id, resolvedEntry);
        const changes = diffProject(previous, manifest);
        const options = yield* optionsFor(manifest);
        const bound = yield* bindings();
        const scopeChanges = changes.units.scopes.added;
        return {
          id: "consent_" + randomBytes(6).toString("hex"),
          projectId: record.project.id,
          projectName: record.project.name,
          createdAt: Date.now(),
          reason: scopeChanges.length > 0 ? "scopes" : "connections",
          summary: scopeChanges.length > 0 ? "Adds scopes: " + scopeChanges.join(", ") : "Adds connection slots",
          diff: toWireDiff(changes.units, options, bound, record.params),
        };
      });

    const planAndApply = (record: ProjectRuntimeRecord, force: boolean): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const resolved = yield* resolveProjectEntry(record.project.root).pipe(Effect.mapError((error) => agentError("invalid", error.message)));
        const fingerprint = yield* Effect.promise(() => projectFingerprint(record.project.root));
        if (!force && record.fingerprint === fingerprint && record.manifest !== undefined) {
          if (record.status !== "error") return record;
          const recovered = yield* setRecord({
            ...record,
            status: record.session === undefined ? "stopped" : "running",
            lastError: undefined,
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
        const next = yield* setRecord({ ...base, appliedManifest: planned.manifest, appliedAt, pendingConsent: undefined, status: record.session === undefined ? "stopped" : "running", lastError: undefined, lastErrorSource: undefined });
        if (next.enabled && next.session === undefined) return yield* startGeneration(next);
        yield* publish(next);
        return next;
      });

    const requestHandler = (record: ProjectRuntimeRecord) => (integration: string, request: string, slot: string, input: unknown): Effect.Effect<unknown, string> =>
      Effect.gen(function* () {
        yield* router.recordOutbound({ projectId: record.project.id, scriptId: record.entry ?? "", integration, slot, request, input });
        return yield* connections.request({ integration, slot, request, input });
      });

    const reconcile = (
      include: ReadonlyArray<ProjectRuntimeRecord>,
      starting?: ProjectRuntimeRecord,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const all = [...(yield* records()), ...include];
        const running: Array<ActiveScript> = all.flatMap((record) => {
          const manifest = record.appliedManifest ?? record.manifest;
          return !record.enabled || manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest, enabled: record.enabled }];
        });
        running.push(...(yield* scripts.running()));
        if (starting?.manifest !== undefined) {
          running.push({ projectId: starting.project.id, scriptId: starting.entry ?? "", manifest: starting.manifest, enabled: starting.enabled });
        }
        const known: Array<ActiveScript> = all.flatMap((record) => {
          const manifest = record.appliedManifest ?? record.manifest;
          return manifest === undefined ? [] : [{ projectId: record.project.id, scriptId: record.entry ?? "", manifest, enabled: record.enabled }];
        });
        known.push(...(yield* scripts.known()));
        yield* connections.reconcile({ running, known });
      });


    const startGeneration = (record: ProjectRuntimeRecord): Effect.Effect<ProjectRuntimeRecord, AgentError> =>
      Effect.gen(function* () {
        const manifest = record.appliedManifest ?? record.manifest;
        if (manifest === undefined || record.entryFile === undefined || record.entry === undefined) {
          return yield* Effect.fail(agentError("invalid", "The project has no applied manifest; plan it first"));
        }
        const generation = record.generation + 1;
        const previous = record.session;
        yield* router.expectSubscriptions({
          projectId: record.project.id,
          scriptId: record.entry,
          subscriptions: manifest.topics.map((topic) => topic.integration + "/" + topic.slot + "/" + topic.topic),
        });
        yield* reconcile([], record);
        yield* connections.ready(manifest.connections.map((connection) => connection.integration + "/" + connection.slot));
        const bundle = yield* bundleScript(record.entryFile, generation).pipe(Effect.mapError((error) => agentError("internal", error.message)));
        const timerDeclaration = (name: string): TimerManifest | undefined => manifest.timers.find((timer) => timer.name === name);
        const session = yield* startRuntimeSession({
          bundlePath: bundle.path,
          generation,
          settings: { get: (key) => record.params[key] },
          request: requestHandler(record),
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
          unitNames: new Map(
            manifest.topics.map((topic) => [
              topic.integration + "/" + topic.slot + "/" + topic.topic,
              topic.name,
            ]),
          ),
        });
        yield* timers.activate({ projectId: record.project.id, generation, session, manifest });
        const next = yield* setRecord({ ...record, appliedManifest: manifest, manifest, generation, status: "running", lastError: undefined, lastErrorSource: undefined, pendingConsent: undefined, session });
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
        let record = yield* requireRecord(projectId);
        yield* saveEnabled(record, true);
        record = yield* setRecord({ ...record, enabled: true });
        record = yield* planAndApply(record, false);
        if (record.pendingConsent !== undefined) return yield* detailOf(record);
        if (record.session !== undefined && record.status === "running") return yield* detailOf(record);
        const started = yield* startGeneration(record);
        return yield* detailOf(started);
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
        const options = yield* optionsFor(record.manifest);
        const bound = yield* bindings();
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
            missingConnections: [],
            missingScopes: [],
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
            missingConnections: [],
            missingScopes: [],
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
        const missingConnections = diff.units.connections.added.map((connection) => ({
          integration: connection.integration,
          slot: connection.slot,
          location: connection.location,
        }));
        const checked: ProjectRuntimeRecord = { ...record, manifest: next.manifest, entry: next.entry.entry, entryFile: next.entry.entryFile };
        return {
          summary: summaryOf(checked),
          ok: true,
          manifest: wireManifest(next.manifest, record.params, options, bound),
          ...(appliedManifest === undefined ? {} : { appliedManifest }),
          units: units(checked, []),
          changes,
          requiresConsent: diff.requiresConsent,
          missingConnections,
          missingScopes: [...diff.units.scopes.added],
          ...(record.pendingConsent === undefined ? {} : { pendingConsent: record.pendingConsent }),
          diagnostics: [],
        };
      }));

    const restart = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      semaphore.withPermit(Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const stopped = record.session === undefined ? record : yield* stopGeneration(record, true);
        const next = yield* planAndApply({ ...stopped, enabled: true }, true);
        const started = next.session === undefined ? yield* startGeneration({ ...next, enabled: true }) : next;
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
          (param.type === "enum" && typeof value === "string");
        if (!valid) return yield* Effect.fail(agentError("invalid", "Param " + key + " expects a " + param.type + " value"));
        const params = { ...record.params, [key]: value };
        yield* saveSettings(record.project, { enabled: record.enabled, params });
        const next = yield* setRecord({ ...record, params });
        if (next.session !== undefined) {
          const restarted = yield* startGeneration(next);
          return yield* detailOf(restarted);
        }
        return yield* detailOf(next);
      }));

    const setEnabled = (projectId: string, enabled: boolean): Effect.Effect<ProjectDetail, AgentError> => enabled ? start(projectId) : stop(projectId);

    const files = (projectId: string): Effect.Effect<{ readonly entry: string; readonly files: ReadonlyArray<ProjectFile> }, AgentError> =>
      Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const filePaths: Array<string> = [];
        const directories: Array<string> = [];
        yield* Effect.tryPromise({
          try: () => walkProject(record.project.root, record.project.root, filePaths, directories),
          catch: (cause) => agentError("internal", String(cause)),
        });
        const all: Array<ProjectFile> = [
          ...directories.map((path) => ({ path, kind: "directory" as const })),
          ...filePaths.map((path) => ({ path, kind: "file" as const })),
        ].sort((left, right) => left.path.localeCompare(right.path));
        return { entry: record.entry ?? "ballast.ts", files: all };
      });

    const readFileAt = (projectId: string, path: string): Effect.Effect<ProjectFileContent, AgentError> =>
      Effect.gen(function* () {
        const record = yield* requireRecord(projectId);
        const root = resolve(record.project.root);
        const absolute = resolve(root, path);
        const relativePath = relative(root, absolute);
        const segments = relativePath.split(sep);
        if (relativePath === "" || relativePath.startsWith("..") || segments.includes(".ballast") || segments.includes("node_modules")) {
          return yield* Effect.fail(agentError("invalid", "File " + path + " is outside the project"));
        }
        const info = yield* Effect.tryPromise({ try: () => stat(absolute), catch: () => agentError("not-found", "No file " + path) });
        if (!info.isFile()) return yield* Effect.fail(agentError("invalid", path + " is not a file"));
        const content = yield* Effect.tryPromise({ try: () => readFile(absolute, "utf8"), catch: (cause) => agentError("internal", String(cause)) });
        return { path: toPosix(relativePath), content, sha256: contentHash(content), updatedAt: info.mtimeMs, language: fileLanguage(path) };
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
        const fingerprint = yield* Effect.promise(() => projectFingerprint(project.root));
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
      needsConsent: all.filter((record) => record.status === "needs-consent").length,
      error: all.filter((record) => record.status === "error").length,
    }));

    const resumeEnabled = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const record of yield* records()) {
          if (!record.enabled || record.session !== undefined) continue;
          yield* start(record.project.id).pipe(Effect.catchCause(() => Effect.void));
        }
      });

    const removeProject = (projectId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = yield* getRecord(projectId);
        if (record !== undefined) {
          yield* stopGeneration(record, false);
          yield* timers.removeProject(projectId);
          yield* Effect.tryPromise({ try: () => rm(join(record.project.root, ".ballast"), { recursive: true, force: true }), catch: () => undefined }).pipe(Effect.ignore);
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
          const next = yield* setRecord({
            ...record,
            appliedManifest: manifest,
            appliedAt,
            pendingConsent: undefined,
            status: record.session === undefined ? "stopped" : "running",
          });
          const started = next.enabled && next.session === undefined ? yield* startGeneration(next) : next;
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
