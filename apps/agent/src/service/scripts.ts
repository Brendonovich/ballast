import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import {
  agentError,
  emptyManifest as emptyWireManifest,
  scriptView,
  type AgentError,
  type CancelTimerRequest,
  type ConsentRequest,
  type ListTimersRequest,
  type ManifestConnection,
  type ManifestDiff,
  type ManifestRequest,
  type ManifestTopic,
  type ParamValue,
  type ParamView,
  type ScriptDetail,
  type ScriptManifest,
  type ScriptSource,
  type ScriptSummary,
  type TimerSummary,
} from "@ballast/agent-protocol";
import type {
  ConnectionManifest,
  Manifest,
  ParamManifest,
  RequestManifest,
  TimerManifest,
  TopicManifest,
} from "@ballast/core";
import { emptyManifest } from "@ballast/core";
import { diff, planDetails } from "@ballast/planner";
import type { ManifestDiff as PlannerDiff } from "@ballast/planner";
import { bundleScript } from "../bundle.ts";
import { startRuntimeSession } from "../runtime-session.ts";
import type { RuntimeSession } from "../runtime-session.ts";
import { contentHash, readJson, readText, writeJsonAtomic } from "./fs.ts";
import { ConnectionManager } from "./connections.ts";
import type { ActiveScript } from "./connections.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";
import { EventRouter, Logs, ServiceHub } from "./telemetry.ts";
import { makeTimerManager } from "./timers.ts";

export interface ScriptRecord {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly scriptId: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly fingerprint: string;
  readonly status: ScriptSummary["status"];
  readonly enabled: boolean;
  readonly generation: number;
  readonly updatedAt: number;
  readonly lastError: string | undefined;
  readonly manifest: Manifest | undefined;
  readonly appliedManifest: Manifest | undefined;
  readonly appliedAt: number | undefined;
  readonly pendingConsent: ConsentRequest | undefined;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly session: RuntimeSession | undefined;
}

interface ScriptSettingsEntry {
  readonly enabled?: boolean;
  readonly params?: Readonly<Record<string, ParamValue>>;
}

interface ProjectSettings {
  readonly version: 1;
  readonly scripts: Readonly<Record<string, ScriptSettingsEntry>>;
}

interface AppliedFile {
  readonly version: 1;
  readonly manifest: Manifest;
  readonly appliedAt: number;
}

const settingsPath = (path: Path.Path, project: ProjectRecord): string =>
  path.join(project.root, ".ballast", "settings.json");

const appliedPath = (path: Path.Path, projectRoot: string, scriptId: string): string =>
  path.join(
    projectRoot,
    ".ballast",
    "applied",
    `${scriptId.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}.json`,
  );

const loadSettings = (
  project: ProjectRecord,
): Effect.Effect<ProjectSettings, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const value = yield* readJson(settingsPath(path, project)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (typeof value !== "object" || value === null) {
    return { version: 1, scripts: {} };
  }
  const scripts = (value as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return { version: 1, scripts: {} };
  }
  const parsed: Record<string, ScriptSettingsEntry> = {};
  for (const [id, entry] of Object.entries(scripts as object)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const params: Record<string, ParamValue> = {};
    if (typeof record["params"] === "object" && record["params"] !== null) {
      for (const [key, param] of Object.entries(record["params"] as object)) {
        if (
          typeof param === "string" ||
          typeof param === "number" ||
          typeof param === "boolean"
        ) {
          params[key] = param;
        }
      }
    }
    parsed[id] = {
      ...(record["enabled"] === true ? { enabled: true } : {}),
      ...(record["enabled"] === false ? { enabled: false } : {}),
      params,
    };
  }
  return { version: 1, scripts: parsed };
  });

const loadApplied = (
  projectRoot: string,
  scriptId: string,
): Effect.Effect<AppliedFile | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
  const path = yield* Path.Path;
  const value = yield* readJson(appliedPath(path, projectRoot, scriptId)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (typeof value !== "object" || value === null) return undefined;
  const manifest = (value as { manifest?: unknown }).manifest;
  if (typeof manifest !== "object" || manifest === null) return undefined;
  return {
    version: 1,
    manifest: manifest as Manifest,
    appliedAt:
      typeof (value as { appliedAt?: unknown }).appliedAt === "number"
        ? (value as { appliedAt: number }).appliedAt
        : Date.now(),
  };
  });

const recordKey = (projectId: string, scriptId: string): string =>
  `${projectId}\u0000${scriptId}`;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export interface ScriptManagerService {
  readonly summaries: (projectId?: string) => Effect.Effect<ReadonlyArray<ScriptSummary>>;
  readonly summary: (projectId: string, scriptId: string) => Effect.Effect<ScriptSummary | undefined>;
  readonly detail: (projectId: string, scriptId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly source: (projectId: string, scriptId: string) => Effect.Effect<ScriptSource, AgentError>;
  readonly syncProject: (projectId: string) => Effect.Effect<void>;
  readonly syncAll: Effect.Effect<void>;
  readonly removeProject: (projectId: string) => Effect.Effect<void>;
  readonly resumeEnabled: (projectId?: string) => Effect.Effect<void>;
  readonly planScript: (projectId: string, scriptId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly startScript: (projectId: string, scriptId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly stopScript: (projectId: string, scriptId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly restartScript: (projectId: string, scriptId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly setParam: (
    projectId: string,
    scriptId: string,
    key: string,
    value: ParamValue,
  ) => Effect.Effect<ScriptDetail, AgentError>;
  readonly setEnabled: (
    projectId: string,
    scriptId: string,
    enabled: boolean,
  ) => Effect.Effect<ScriptDetail, AgentError>;
  readonly listTimers: (request: ListTimersRequest) => Effect.Effect<ReadonlyArray<TimerSummary>>;
  readonly cancelTimer: (request: CancelTimerRequest) => Effect.Effect<boolean>;
  readonly consents: (projectId?: string) => Effect.Effect<ReadonlyArray<ConsentRequest>>;
  readonly approve: (consentId: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly reject: (consentId: string, reason?: string) => Effect.Effect<ScriptDetail, AgentError>;
  readonly running: () => Effect.Effect<ReadonlyArray<ActiveScript>>;
  readonly known: () => Effect.Effect<ReadonlyArray<ActiveScript>>;
  readonly reconcileConnections: Effect.Effect<void>;
  readonly closeAll: () => Effect.Effect<void>;
  readonly counts: Effect.Effect<{
    readonly total: number;
    readonly running: number;
    readonly needsConsent: number;
    readonly error: number;
  }>;
}

export class ScriptManager extends Context.Service<ScriptManager, ScriptManagerService>()(
  "ballast/service/ScriptManager",
) {}

const toWireConnection = (
  connection: ConnectionManifest,
  bound: { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> } | undefined,
): ManifestConnection => ({
  integration: connection.integration,
  slot: connection.slot,
  location: connection.location,
  ...(bound === undefined
    ? {}
    : { connectionId: bound.id, connectionStatus: bound.status }),
});

const toWireTopic = (topic: TopicManifest): ManifestTopic => ({
  integration: topic.integration,
  slot: topic.slot,
  topic: topic.topic,
  scopes: [...topic.scopes],
  onStale: topic.onStale,
  maxAgeMs: topic.maxAgeMs,
  ...(topic.condition === undefined ? {} : { condition: topic.condition }),
});

const toWireRequest = (request: RequestManifest): ManifestRequest => ({
  integration: request.integration,
  slot: request.slot,
  request: request.request,
  scopes: [...request.scopes],
});

const toParamView = (
  param: ParamManifest,
  values: Readonly<Record<string, ParamValue>>,
  options: ReadonlyArray<string> | undefined,
): ParamView => {
  const value = values[param.key] ?? param.default;
  return {
    key: param.key,
    type: param.type,
    ...(param.title === undefined ? {} : { title: param.title }),
    ...(param.description === undefined ? {} : { description: param.description }),
    ...(param.default === undefined ? {} : { default: param.default }),
    ...(value === undefined ? {} : { value }),
    required: param.default === undefined && values[param.key] === undefined,
    ...(options === undefined ? {} : { options }),
    ...(param.options === undefined
      ? {}
      : {
          optionsSource: {
            integration: param.options.integration,
            slot: param.options.slot,
            source: param.options.source,
          },
        }),
    ...(param.default === undefined && values[param.key] === undefined
      ? { error: "A value is required" }
      : {}),
  };
};

export const toWireManifest = (
  manifest: Manifest,
  values: Readonly<Record<string, ParamValue>>,
  options: ReadonlyMap<string, ReadonlyArray<string>>,
  connections: ReadonlyMap<
    string,
    { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> }
  >,
): ScriptManifest => ({
  params: manifest.params.map((param) =>
    toParamView(param, values, options.get(param.key)),
  ),
  connections: manifest.connections.map((connection) =>
    toWireConnection(connection, connections.get(`${connection.integration}/${connection.slot}`)),
  ),
  topics: manifest.topics.map(toWireTopic),
  requests: manifest.requests.map(toWireRequest),
  unresolved: manifest.unresolved.map((entry) => ({ path: entry.path, reason: entry.reason })),
  timers: manifest.timers.map((timer) => ({
    name: timer.name,
    ...(timer.title === undefined ? {} : { title: timer.title }),
    onStale: timer.onStale,
    maxAgeMs: timer.maxAgeMs,
    payloadFingerprint: timer.payloadFingerprint,
  })),
});

export const toWireDiff = (
  changes: PlannerDiff,
  options: ReadonlyMap<string, ReadonlyArray<string>>,
  connections: ReadonlyMap<
    string,
    { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> }
  >,
  values: Readonly<Record<string, ParamValue>>,
): ManifestDiff => ({
  requiresConsent: changes.requiresConsent,
  added: {
    connections: changes.connections.added.map((connection) =>
      toWireConnection(
        connection,
        connections.get(`${connection.integration}/${connection.slot}`),
      ),
    ),
    topics: changes.topics.added.map(toWireTopic),
    requests: changes.requests.added.map(toWireRequest),
    scopes: [...changes.scopes.added],
    params: changes.params.added.map((param) =>
      toParamView(param, values, options.get(param.key)),
    ),
  },
  removed: {
    connections: changes.connections.removed.map((connection) =>
      toWireConnection(
        connection,
        connections.get(`${connection.integration}/${connection.slot}`),
      ),
    ),
    topics: changes.topics.removed.map(toWireTopic),
    requests: changes.requests.removed.map(toWireRequest),
    scopes: [...changes.scopes.removed],
    params: changes.params.removed.map((param) =>
      toParamView(param, values, options.get(param.key)),
    ),
  },
});

const consentReason = (changes: PlannerDiff): ConsentRequest["reason"] => {
  const scopes = changes.scopes.added.length > 0;
  const connections = changes.connections.added.length > 0;
  return scopes && connections ? "both" : connections ? "connections" : "scopes";
};

const consentSummary = (changes: PlannerDiff): string => {
  const parts: Array<string> = [];
  if (changes.scopes.added.length > 0) {
    parts.push(`scopes: ${changes.scopes.added.join(", ")}`);
  }
  if (changes.connections.added.length > 0) {
    parts.push(
      `connections: ${changes.connections.added
        .map((connection) => `${connection.integration}/${connection.slot}`)
        .join(", ")}`,
    );
  }
  return parts.length === 0 ? "Adds new permissions" : `Adds ${parts.join("; ")}`;
};

export const ScriptManagerLive = Layer.effect(
  ScriptManager,
  Effect.gen(function* () {
    const projects = yield* ProjectManager;
    const connections = yield* ConnectionManager;
    const logs = yield* Logs;
    const router = yield* EventRouter;
    const hub = yield* ServiceHub;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const platform = yield* Effect.context<
      Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
    const clock = yield* Effect.clockWith((value) => Effect.succeed(value));
    const timers = yield* makeTimerManager({ clock, logs, hub });
    const state = yield* Ref.make<ReadonlyMap<string, ScriptRecord>>(new Map());
    const settings = yield* Ref.make<ReadonlyMap<string, ProjectSettings>>(new Map());
    const semaphore = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();

    const records = (): Effect.Effect<ReadonlyArray<ScriptRecord>> =>
      Effect.map(Ref.get(state), (current) => [...current.values()]);

    const getRecord = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptRecord | undefined> =>
      Effect.map(Ref.get(state), (current) => current.get(recordKey(projectId, scriptId)));

    const setRecord = (record: ScriptRecord): Effect.Effect<ScriptRecord> =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => {
          const next = new Map(current);
          next.set(recordKey(record.projectId, record.scriptId), record);
          return next;
        });
        return record;
      });

    const removeRecord = (projectId: string, scriptId: string): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        const next = new Map(current);
        next.delete(recordKey(projectId, scriptId));
        return next;
      });

    const projectSettings = (project: ProjectRecord): Effect.Effect<ProjectSettings> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(settings)).get(project.id);
        if (cached !== undefined) return cached;
        const loaded = yield* provide(loadSettings(project));
        yield* Ref.update(settings, (current) => {
          const next = new Map(current);
          next.set(project.id, loaded);
          return next;
        });
        return loaded;
      });

    const saveSettings = (project: ProjectRecord): Effect.Effect<void> =>
      Effect.gen(function* () {
        const value = (yield* Ref.get(settings)).get(project.id);
        if (value === undefined) return;
        yield* provide(
          writeJsonAtomic(settingsPath(path, project), value, 0o600),
        ).pipe(
          Effect.mapError(errorMessage),
        ).pipe(
          Effect.catch((reason) =>
            logs.write({
              level: "error",
              source: "agent",
              projectId: project.id,
              message: `could not save project settings: ${reason}`,
            }),
          ),
        );
      });

    const updateSettings = (
      project: ProjectRecord,
      scriptId: string,
      update: (entry: ScriptSettingsEntry) => ScriptSettingsEntry,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* projectSettings(project);
        const nextEntry = update(current.scripts[scriptId] ?? {});
        const next: ProjectSettings = {
          version: 1,
          scripts: { ...current.scripts, [scriptId]: nextEntry },
        };
        yield* Ref.update(settings, (map) => {
          const copy = new Map(map);
          copy.set(project.id, next);
          return copy;
        });
        yield* saveSettings(project);
      });

    const appliedFile = (record: ScriptRecord): Effect.Effect<void> => {
      const manifest = record.appliedManifest;
      const appliedAt = record.appliedAt;
      if (manifest === undefined || appliedAt === undefined) return Effect.void;
      const file: AppliedFile = { version: 1, manifest, appliedAt };
      return provide(
        writeJsonAtomic(
          appliedPath(path, record.projectRoot, record.scriptId),
          file,
          0o600,
        ),
      ).pipe(
        Effect.mapError(errorMessage),
      ).pipe(
            Effect.catch((reason) =>
              logs.write({
                level: "error",
                source: "agent",
                projectId: record.projectId,
                scriptId: record.scriptId,
                message: `could not save the applied manifest: ${reason}`,
              }),
            ),
          );
    };

    const summaryOf = (record: ScriptRecord): ScriptSummary => ({
      projectId: record.projectId,
      id: record.scriptId,
      name: record.name,
      entry: record.scriptId,
      status: record.status,
      enabled: record.enabled,
      generation: record.generation,
      updatedAt: record.updatedAt,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    });

    const publishScript = (record: ScriptRecord): Effect.Effect<void> =>
      hub.publish({ _tag: "script", script: summaryOf(record) });

    const publishConsent = (consent: ConsentRequest): Effect.Effect<void> =>
      hub.publish({ _tag: "consent", consent });

    const resolveOptions = (
      manifest: Manifest | undefined,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
      Effect.gen(function* () {
        const options = new Map<string, ReadonlyArray<string>>();
        if (manifest === undefined) return options;
        for (const param of manifest.params) {
          if (param.options === undefined) continue;
          const values = yield* connections.optionValues(param.options).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (values !== undefined) options.set(param.key, values);
        }
        return options;
      });

    const connectionBindings = (): Effect.Effect<
      ReadonlyMap<string, { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> }>
    > =>
      Effect.gen(function* () {
        const summaries = yield* connections.summaries();
        const map = new Map<
          string,
          { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> }
        >();
        for (const summary of summaries) {
          map.set(summary.id, {
            id: summary.id,
            status: summary.status,
          });
        }
        return map;
      });

    const detailOf = (record: ScriptRecord): Effect.Effect<ScriptDetail> =>
      Effect.gen(function* () {
        const options = yield* resolveOptions(record.manifest);
        const bindings = yield* connectionBindings();
        const values = record.params;
        return {
          summary: summaryOf(record),
          manifest:
            record.manifest === undefined
              ? emptyWireManifest()
              : toWireManifest(record.manifest, values, options, bindings),
          ...(record.appliedManifest === undefined
            ? {}
            : {
                appliedManifest: toWireManifest(
                  record.appliedManifest,
                  values,
                  options,
                  bindings,
                ),
              }),
          ...(record.appliedAt === undefined ? {} : { appliedAt: record.appliedAt }),
          ...(record.pendingConsent === undefined
            ? {}
            : { pendingConsent: record.pendingConsent }),
          view: scriptView(),
        };
      });

    const requireRecord = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptRecord, AgentError> =>
      Effect.gen(function* () {
        const record = yield* getRecord(projectId, scriptId);
        if (record === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `No script "${scriptId}" in project "${projectId}"`),
          );
        }
        return record;
      });

    const resolveDir = yield* path.fromFileUrl(new URL(".", import.meta.url));

    const planEntry = (record: ScriptRecord) =>
      planDetails(record.absolutePath, {
        scriptId: record.scriptId,
        resolveDir,
      }).pipe(
        Effect.mapError((error) => agentError("invalid", error.message)),
      );

    const markError = (
      record: ScriptRecord,
      message: string,
    ): Effect.Effect<ScriptRecord> =>
      Effect.gen(function* () {
        const next = yield* setRecord({
          ...record,
          status: "error",
          lastError: message,
          updatedAt: Date.now(),
        });
        yield* logs.write({
          level: "error",
          source: "agent",
          projectId: record.projectId,
          scriptId: record.scriptId,
          message,
        });
        yield* publishScript(next);
        return next;
      });

    const reconcileConnections: Effect.Effect<void> = Effect.suspend(() =>
      Effect.gen(function* () {
        const all = yield* records();
        const running: Array<ActiveScript> = all.flatMap((record) =>
          record.session === undefined || record.manifest === undefined
            ? []
            : [
                {
                  projectId: record.projectId,
                  scriptId: record.scriptId,
                  manifest: record.manifest,
                  enabled: record.enabled,
                },
              ],
        );
        const known: Array<ActiveScript> = all.flatMap((record) =>
          record.manifest === undefined
            ? []
            : [
                {
                  projectId: record.projectId,
                  scriptId: record.scriptId,
                  manifest: record.manifest,
                  enabled: record.enabled,
                },
              ],
        );
        yield* connections.reconcile({ running, known });
      }),
    );

    const requestHandler = (record: ScriptRecord) => (
      integration: string,
      request: string,
      slot: string,
      input: unknown,
    ): Effect.Effect<unknown, string> =>
      Effect.gen(function* () {
        yield* router.recordOutbound({
          projectId: record.projectId,
          scriptId: record.scriptId,
          integration,
          slot,
          request,
          input,
        });
        return yield* connections.request({ integration, slot, request, input });
      });

    const prepareConnections = (
      record: ScriptRecord,
      manifest: Manifest,
    ): Effect.Effect<void, AgentError> =>
      Effect.gen(function* () {
        const all = yield* records();
        const active: ActiveScript = {
          projectId: record.projectId,
          scriptId: record.scriptId,
          manifest,
          enabled: record.enabled,
        };
        const running = all.flatMap((entry) =>
          entry.session === undefined || entry.manifest === undefined
            ? []
            : [
                {
                  projectId: entry.projectId,
                  scriptId: entry.scriptId,
                  manifest: entry.manifest,
                  enabled: entry.enabled,
                },
              ],
        );
        running.push(active);
        const known = all.flatMap((entry) =>
          entry.manifest === undefined
            ? []
            : [
                {
                  projectId: entry.projectId,
                  scriptId: entry.scriptId,
                  manifest: entry.manifest,
                  enabled: entry.enabled,
                },
              ],
        );
        known.push(active);
        yield* connections.reconcile({ running, known });
        yield* connections.ready(
          manifest.connections.map(
            (connection) => `${connection.integration}/${connection.slot}`,
          ),
        );
      });

    const startGeneration = (
      record: ScriptRecord,
      manifest: Manifest,
    ): Effect.Effect<ScriptRecord, AgentError> =>
      Effect.gen(function* () {
        const previous = record.session;
        // Declare the subscriptions this generation will register before the
        // connection drivers start. A cloud relay can replay an event as soon
        // as its listener attaches; the router buffers it here until the worker
        // has registered the topic (and drops it if the start fails).
        yield* router.expectSubscriptions({
          projectId: record.projectId,
          scriptId: record.scriptId,
          subscriptions: manifest.topics.map(
            (topic) => `${topic.integration}/${topic.slot}/${topic.topic}`,
          ),
        });
        yield* prepareConnections(record, manifest);
        const generation = record.generation + 1;
        const params = record.params;
        const bundle = yield* provide(bundleScript(record.absolutePath, generation)).pipe(
          Effect.mapError((error) => agentError("internal", error.message)),
        );
        const declarationFor = (name: string): TimerManifest | undefined =>
          manifest.timers.find((timer) => timer.name === name);
        const session = yield* startRuntimeSession({
          bundlePath: bundle.path,
          generation,
          settings: { get: (key) => params[key] },
          request: requestHandler(record),
          registerTimer: (name) => {
            if (declarationFor(name) === undefined) {
              return Effect.die(
                new Error(
                  `Timer "${name}" was registered without a declaration in the running manifest`,
                ),
              );
            }
            return timers.registerName({
              projectId: record.projectId,
              scriptId: record.scriptId,
              generation,
              name,
            });
          },
          scheduleTimer: (input) => {
            const declaration = declarationFor(input.name);
            if (declaration === undefined) {
              return Effect.fail(
                `Timer "${input.name}" is not declared by the running manifest`,
              );
            }
            if (input.payloadFingerprint !== declaration.payloadFingerprint) {
              return Effect.fail(
                `Timer "${input.name}" payload fingerprint does not match the running manifest`,
              );
            }
            if (
              input.onStale !== declaration.onStale ||
              input.maxAgeMs !== declaration.maxAgeMs
            ) {
              return Effect.fail(
                `Timer "${input.name}" policy does not match the running manifest`,
              );
            }
            return timers.schedule({
              projectId: record.projectId,
              scriptId: record.scriptId,
              generation,
              declaration,
              manifest,
              key: input.key,
              delayMs: input.delayMs,
              payload: input.payload,
            });
          },
          cancelTimer: (input) =>
            timers
              .cancel({
                projectId: record.projectId,
                scriptId: record.scriptId,
                timer: input.name,
                key: input.key,
              })
              .pipe(Effect.asVoid),
          onLog: (line) => {
            Effect.runForkWith(context)(
              logs
                .write({
                  level: line.level,
                  source: "worker",
                  projectId: record.projectId,
                  scriptId: record.scriptId,
                  message: line.message,
                })
                .pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const prefix = `[${record.projectId}/${record.scriptId}]`;
                      if (line.level === "error") console.error(`${prefix} ${line.message}`);
                      else console.log(`${prefix} ${line.message}`);
                    }),
                  ),
                ),
            );
          },
        }).pipe(
          Effect.mapError((error) => agentError("internal", error.message)),
        );

        yield* router.register({
          projectId: record.projectId,
          scriptId: record.scriptId,
          session,
        });
        yield* timers.activate({
          projectId: record.projectId,
          scriptId: record.scriptId,
          generation,
          session,
          manifest,
        });

        const next: ScriptRecord = {
          ...record,
          manifest,
          appliedManifest: manifest,
          appliedAt: Date.now(),
          pendingConsent: undefined,
          generation,
          status: "running",
          lastError: undefined,
          updatedAt: Date.now(),
          session,
        };

        const result = yield* setRecord(next).pipe(
          Effect.onError(() => session.close),
        );
        yield* appliedFile(result);
        yield* reconcileConnections;
        if (previous !== undefined) yield* previous.close;
        yield* logs.write({
          level: "info",
          source: "agent",
          projectId: record.projectId,
          scriptId: record.scriptId,
          message: `started worker generation ${generation}`,
        });
        yield* publishScript(result);
        return result;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* router.cancelExpected({
              projectId: record.projectId,
              scriptId: record.scriptId,
            });
            yield* timers.deactivate({
              projectId: record.projectId,
              scriptId: record.scriptId,
              generation: record.generation + 1,
            });
            yield* markError(record, error.message);
            return yield* Effect.fail(error);
          }),
        ),
      );

    const consentFor = (
      record: ScriptRecord,
      _manifest: Manifest,
      changes: PlannerDiff,
      options: ReadonlyMap<string, ReadonlyArray<string>>,
      bindings: ReadonlyMap<
        string,
        { readonly id: string; readonly status: NonNullable<ManifestConnection["connectionStatus"]> }
      >,
    ): Effect.Effect<ConsentRequest> =>
      Effect.gen(function* () {
        const id = yield* crypto.randomBytes(6).pipe(
          Effect.map((bytes) => Hex.encode(bytes)),
          Effect.orDie,
        );
        return {
          id: `consent_${id}`,
          projectId: record.projectId,
          scriptId: record.scriptId,
          scriptName: record.name,
          createdAt: Date.now(),
          reason: consentReason(changes),
          summary: consentSummary(changes),
          diff: toWireDiff(changes, options, bindings, record.params),
        };
      });

    const beginStart = (
      record: ScriptRecord,
      approved: boolean,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      Effect.gen(function* () {
        const planned = yield* planEntry(record);
        const manifest = planned.manifest;
        const current = { ...record, name: planned.title };
        const missing = manifest.params.filter(
          (param) => param.default === undefined && record.params[param.key] === undefined,
        );
        if (missing.length > 0) {
          return yield* Effect.fail(
            agentError(
              "invalid",
              `Missing required param${missing.length === 1 ? "" : "s"}: ${missing
                .map((param) => param.key)
                .join(", ")}`,
            ),
          );
        }
        const previous = record.appliedManifest ?? emptyManifest(record.scriptId);
        const changes = diff(previous, manifest);
        if (changes.requiresConsent && !approved) {
          const options = yield* resolveOptions(manifest);
          const bindings = yield* connectionBindings();
          const consent = yield* consentFor(current, manifest, changes, options, bindings);
          const next = yield* setRecord({
            ...current,
            manifest,
            status: "needs-consent",
            pendingConsent: consent,
            updatedAt: Date.now(),
            lastError: undefined,
          });
          yield* publishConsent(consent);
          yield* publishScript(next);
          return yield* Effect.fail(
            agentError(
              "conflict",
              `Script ${record.projectId}/${record.scriptId} needs consent before it can start`,
            ),
          );
        }
        const started = yield* startGeneration(current, manifest);
        return yield* detailOf(started);
      });

    const startRecord = (
      record: ScriptRecord,
      approved: boolean,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      Effect.gen(function* () {
        const project = yield* projects.get(record.projectId);
        if (project === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `No project "${record.projectId}"`),
          );
        }
        yield* updateSettings(project, record.scriptId, (entry) => ({
          ...entry,
          enabled: true,
        }));
        const enabled = yield* setRecord({ ...record, enabled: true, updatedAt: Date.now() });
        return yield* beginStart(enabled, approved);
      });

    const stopRecord = (
      record: ScriptRecord,
      enabled: boolean,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      Effect.gen(function* () {
        const project = yield* projects.get(record.projectId);
        if (project === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `No project "${record.projectId}"`),
          );
        }
        const session = record.session;
        yield* timers.deactivate({
          projectId: record.projectId,
          scriptId: record.scriptId,
          generation: record.generation,
        });
        if (session !== undefined) yield* session.close;
        yield* router.unregister(recordKey(record.projectId, record.scriptId));
        yield* updateSettings(project, record.scriptId, (entry) => ({
          ...entry,
          enabled,
        }));
        const next = yield* setRecord({
          ...record,
          session: undefined,
          enabled,
          status: "stopped",
          pendingConsent: undefined,
          updatedAt: Date.now(),
        });
        yield* reconcileConnections;
        yield* publishScript(next);
        return yield* detailOf(next);
      });

    const source = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptSource, AgentError> =>
      Effect.gen(function* () {
        const record = yield* requireRecord(projectId, scriptId);
        const content = yield* provide(readText(record.absolutePath)).pipe(
          Effect.mapError((cause) => agentError("internal", cause.message)),
        );
        if (content === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `Script file "${record.absolutePath}" does not exist`),
          );
        }
        const fileStat = yield* provide(fs.stat(record.absolutePath)).pipe(
          Effect.mapError((cause) => agentError("internal", cause.message)),
        );
        const digest = yield* provide(
          crypto.digest("SHA-256", new TextEncoder().encode(content)),
        ).pipe(Effect.orDie);
        return {
          path: record.scriptId,
          content,
          sha256: Hex.encode(digest),
          updatedAt: Option.getOrElse(fileStat.mtime, () => new Date()).getTime(),
          language: "typescript",
        };
      });

    const planScript = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          const planned = yield* planEntry(record).pipe(
            Effect.catch((error) =>
              markError(record, error.message).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
          const next = yield* setRecord({
            ...record,
            name: planned.title,
            manifest: planned.manifest,
            lastError: undefined,
            updatedAt: Date.now(),
          });
          yield* publishScript(next);
          return yield* detailOf(next);
        }),
      );

    const startScript = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          return yield* startRecord(record, false);
        }),
      );

    const stopScript = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          return yield* stopRecord(record, false);
        }),
      );

    const restartScript = (
      projectId: string,
      scriptId: string,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          return yield* startRecord(record, false);
        }),
      );

    const setEnabled = (
      projectId: string,
      scriptId: string,
      enabled: boolean,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          return enabled
            ? yield* startRecord(record, false)
            : yield* stopRecord(record, false);
        }),
      );

    const setParam = (
      projectId: string,
      scriptId: string,
      key: string,
      value: ParamValue,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(projectId, scriptId);
          const manifest = record.manifest;
          if (manifest === undefined) {
            return yield* Effect.fail(
              agentError("invalid", `Script ${projectId}/${scriptId} has no manifest yet`),
            );
          }
          const param = manifest.params.find((candidate) => candidate.key === key);
          if (param === undefined) {
            return yield* Effect.fail(
              agentError("invalid", `Script ${projectId}/${scriptId} has no param "${key}"`),
            );
          }
          const validType =
            (param.type === "string" && typeof value === "string") ||
            (param.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
            (param.type === "boolean" && typeof value === "boolean") ||
            (param.type === "enum" && typeof value === "string") ||
            (param.type === "strings" &&
              Array.isArray(value) &&
              value.every((entry) => typeof entry === "string"));
          if (!validType) {
            return yield* Effect.fail(
              agentError("invalid", `Param "${key}" expects a ${param.type} value`),
            );
          }
          if ((param.type === "enum" || param.type === "strings") && param.options !== undefined) {
            const options = yield* connections.optionValues(param.options).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (options !== undefined) {
              const selected =
                param.type === "strings" && Array.isArray(value)
                  ? value.filter((entry): entry is string => typeof entry === "string")
                  : typeof value === "string"
                    ? [value]
                    : [];
              if (selected.some((entry) => !options.includes(entry))) {
                return yield* Effect.fail(
                  agentError(
                    "invalid",
                    `Param "${key}" must be one of: ${options.join(", ")}`,
                  ),
                );
              }
            }
          }
          const project = yield* projects.get(projectId);
          if (project === undefined) {
            return yield* Effect.fail(agentError("not-found", `No project "${projectId}"`));
          }
          const params = { ...record.params, [key]: value };
          yield* updateSettings(project, scriptId, (entry) => ({ ...entry, params }));
          const updated = yield* setRecord({
            ...record,
            params,
            updatedAt: Date.now(),
          });
          if (updated.session !== undefined) {
            const started = yield* startGeneration(updated, manifest);
            return yield* detailOf(started);
          }
          yield* publishScript(updated);
          return yield* detailOf(updated);
        }),
      );

    const consents = (projectId?: string): Effect.Effect<ReadonlyArray<ConsentRequest>> =>
      Effect.map(records(), (all) =>
        all.flatMap((record) =>
          record.pendingConsent === undefined ||
          (projectId !== undefined && record.projectId !== projectId)
            ? []
            : [record.pendingConsent],
        ),
      );

    const findConsent = (
      consentId: string,
    ): Effect.Effect<ScriptRecord, AgentError> =>
      Effect.gen(function* () {
        const all = yield* records();
        const record = all.find(
          (candidate) => candidate.pendingConsent?.id === consentId,
        );
        if (record === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `No pending consent "${consentId}"`),
          );
        }
        return record;
      });

    const approve = (consentId: string): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* findConsent(consentId);
          const consent = record.pendingConsent;
          const detail = yield* startRecord(record, true);
          if (consent !== undefined) {
            yield* hub.publish({
              _tag: "consent-resolved",
              projectId: record.projectId,
              scriptId: record.scriptId,
              consentId: consent.id,
              approved: true,
              script: detail.summary,
            });
          }
          return detail;
        }),
      );

    const reject = (
      consentId: string,
      _reason?: string,
    ): Effect.Effect<ScriptDetail, AgentError> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const record = yield* findConsent(consentId);
          const consent = record.pendingConsent;
          const project = yield* projects.get(record.projectId);
          if (project === undefined) {
            return yield* Effect.fail(
              agentError("not-found", `No project "${record.projectId}"`),
            );
          }
          const running = record.session !== undefined;
          if (!running) {
            yield* updateSettings(project, record.scriptId, (entry) => ({
              ...entry,
              enabled: false,
            }));
          }
          const next = yield* setRecord({
            ...record,
            pendingConsent: undefined,
            status: running ? "running" : "stopped",
            enabled: running ? record.enabled : false,
            updatedAt: Date.now(),
          });
          yield* publishScript(next);
          if (consent !== undefined) {
            yield* hub.publish({
              _tag: "consent-resolved",
              projectId: record.projectId,
              scriptId: record.scriptId,
              consentId: consent.id,
              approved: false,
              script: summaryOf(next),
            });
          }
          return yield* detailOf(next);
        }),
      );

    const fingerprintOf = (absolutePath: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const content = yield* provide(readText(absolutePath)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (content === undefined) return "missing";
        return yield* provide(contentHash(content)).pipe(Effect.orDie);
      });

    const planOnly = (record: ScriptRecord): Effect.Effect<ScriptRecord> =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(planEntry(record));
        if (Exit.isFailure(result)) {
          const cause = Cause.squash(result.cause);
          return yield* markError(
            record,
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        const next = yield* setRecord({
          ...record,
          name: result.value.title,
          manifest: result.value.manifest,
          status: record.session === undefined ? "stopped" : record.status,
          lastError: undefined,
          updatedAt: Date.now(),
        });
        return next;
      });

    const reloadRunning = (record: ScriptRecord): Effect.Effect<void> =>
      Effect.gen(function* () {
        const planned = yield* planEntry(record).pipe(
          Effect.catch((error) => markError(record, error.message).pipe(Effect.as(undefined))),
        );
        if (planned === undefined) return;
        const manifest = planned.manifest;
        const current = { ...record, name: planned.title };
        const previous = record.appliedManifest ?? emptyManifest(record.scriptId);
        const changes = diff(previous, manifest);
        if (changes.requiresConsent) {
          const options = yield* resolveOptions(manifest);
          const bindings = yield* connectionBindings();
          const consent = yield* consentFor(current, manifest, changes, options, bindings);
          const next = yield* setRecord({
            ...current,
            manifest,
            status: "needs-consent",
            pendingConsent: consent,
            updatedAt: Date.now(),
            lastError: undefined,
          });
          yield* publishConsent(consent);
          yield* publishScript(next);
          return;
        }
        yield* startGeneration({ ...current, manifest }, manifest).pipe(
          Effect.catch(() => Effect.void),
        );
      });

    const syncProject = (projectId: string): Effect.Effect<void> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const project = yield* projects.get(projectId);
          if (project === undefined) return;
          yield* timers.loadProject({ id: project.id, root: project.root });
          const discovered = yield* projects.scan(project);
          const discoveredIds = new Set(discovered.map((entry) => entry.id));
          const current = (yield* records()).filter(
            (record) => record.projectId === projectId,
          );
          for (const record of current) {
            if (discoveredIds.has(record.scriptId)) continue;
            if (record.session !== undefined) yield* record.session.close;
            yield* timers.deactivate({
              projectId: record.projectId,
              scriptId: record.scriptId,
            });
            yield* timers.removeScript(record.projectId, record.scriptId);
            yield* router.unregister(recordKey(record.projectId, record.scriptId));
            yield* removeRecord(record.projectId, record.scriptId);
            yield* hub.publish({
              _tag: "script-removed",
              projectId: record.projectId,
              scriptId: record.scriptId,
            });
          }

          const projectSettingsValue = yield* projectSettings(project);
          for (const discoveredScript of discovered) {
            const existing = yield* getRecord(projectId, discoveredScript.id);
            const fingerprint = yield* fingerprintOf(discoveredScript.absolutePath);
            if (fingerprint === "missing") continue;
            if (existing === undefined) {
              const applied = yield* provide(
                loadApplied(project.root, discoveredScript.id),
              ).pipe(Effect.catch(() => Effect.succeed(undefined)));
              const entry = projectSettingsValue.scripts[discoveredScript.id];
              const record: ScriptRecord = {
                projectId,
                projectRoot: project.root,
                scriptId: discoveredScript.id,
                name: discoveredScript.name,
                absolutePath: discoveredScript.absolutePath,
                fingerprint,
                status: "stopped",
                enabled: entry?.enabled === true,
                generation: 0,
                updatedAt: Date.now(),
                lastError: undefined,
                manifest: undefined,
                appliedManifest: applied?.manifest,
                appliedAt: applied?.appliedAt,
                pendingConsent: undefined,
                params: entry?.params ?? {},
                session: undefined,
              };
              yield* setRecord(record);
              const planned = yield* planOnly(record);
              yield* publishScript(planned);
              if (planned.enabled && planned.session === undefined) {
                yield* beginStart(planned, false).pipe(Effect.catch(() => Effect.void));
              }
              continue;
            }
            if (existing.fingerprint === fingerprint) continue;
            const updated = yield* setRecord({
              ...existing,
              name: discoveredScript.name,
              absolutePath: discoveredScript.absolutePath,
              fingerprint,
              updatedAt: Date.now(),
            });
            yield* hub.publish({
              _tag: "script-source-changed",
              projectId,
              scriptId: discoveredScript.id,
              sha256: fingerprint,
              updatedAt: updated.updatedAt,
            });
            if (updated.session !== undefined) {
              yield* reloadRunning(updated);
            } else {
              const planned = yield* planOnly(updated);
              yield* publishScript(planned);
              if (planned.enabled) {
                yield* beginStart(planned, false).pipe(Effect.catch(() => Effect.void));
              }
            }
          }
          if ((yield* records()).some((record) => record.projectId === projectId)) {
            yield* reconcileConnections;
          }
        }),
      );

    const syncAll: Effect.Effect<void> = Effect.gen(function* () {
      const all = yield* projects.projects;
      for (const project of all) yield* syncProject(project.id);
    });

    const removeProject = (projectId: string): Effect.Effect<void> =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* records()).filter(
            (record) => record.projectId === projectId,
          );
          for (const record of current) {
            if (record.session !== undefined) yield* record.session.close;
            yield* router.unregister(recordKey(record.projectId, record.scriptId));
            yield* removeRecord(record.projectId, record.scriptId);
            yield* hub.publish({
              _tag: "script-removed",
              projectId: record.projectId,
              scriptId: record.scriptId,
            });
          }
          yield* timers.removeProject(projectId);
          yield* reconcileConnections;
        }),
      );

    const resumeEnabled = (projectId?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const all = (yield* records()).filter(
          (record) =>
            record.enabled &&
            record.session === undefined &&
            (projectId === undefined || record.projectId === projectId),
        );
        for (const record of all) {
          yield* semaphore
            .withPermit(startRecord(record, false))
            .pipe(Effect.catch(() => Effect.void));
        }
      });

    const running = (): Effect.Effect<ReadonlyArray<ActiveScript>> =>
      Effect.map(records(), (all) =>
        all.flatMap((record) =>
          record.session === undefined || record.manifest === undefined
            ? []
            : [
                {
                  projectId: record.projectId,
                  scriptId: record.scriptId,
                  manifest: record.manifest,
                  enabled: record.enabled,
                },
              ],
        ),
      );

    const known = (): Effect.Effect<ReadonlyArray<ActiveScript>> =>
      Effect.map(records(), (all) =>
        all.flatMap((record) =>
          record.manifest === undefined
            ? []
            : [
                {
                  projectId: record.projectId,
                  scriptId: record.scriptId,
                  manifest: record.manifest,
                  enabled: record.enabled,
                },
              ],
        ),
      );

    const closeAll = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const record of yield* records()) {
          yield* timers.deactivate({
            projectId: record.projectId,
            scriptId: record.scriptId,
            generation: record.generation,
          });
          yield* router.unregister(recordKey(record.projectId, record.scriptId));
          if (record.session !== undefined) yield* record.session.close;
        }
      });

    const counts = Effect.gen(function* () {
      const all = yield* records();
      return {
        total: all.length,
        running: all.filter((record) => record.status === "running").length,
        needsConsent: all.filter((record) => record.status === "needs-consent").length,
        error: all.filter((record) => record.status === "error").length,
      };
    });

    yield* Effect.addFinalizer(() => closeAll());

    return {
      summaries: (projectId?: string) =>
        Effect.map(records(), (all) =>
          all
            .filter(
              (record) => projectId === undefined || record.projectId === projectId,
            )
            .map(summaryOf),
        ),
      summary: (projectId, scriptId) =>
        Effect.map(getRecord(projectId, scriptId), (record) =>
          record === undefined ? undefined : summaryOf(record),
        ),
      detail: (projectId, scriptId) =>
        Effect.flatMap(requireRecord(projectId, scriptId), detailOf),
      source,
      syncProject,
      syncAll,
      removeProject,
      resumeEnabled,
      planScript,
      startScript,
      stopScript,
      restartScript,
      setParam,
      setEnabled,
      listTimers: (request: ListTimersRequest) => timers.list(request),
      cancelTimer: (request: CancelTimerRequest) =>
        timers.cancel({
          projectId: request.projectId,
          scriptId: request.scriptId ?? "",
          timer: request.timer,
          key: request.key,
        }),
      consents,
      approve,
      reject,
      running,
      known,
      reconcileConnections,
      closeAll,
      counts,
    };
  }),
);
