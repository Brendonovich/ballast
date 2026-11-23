import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  AGENT_API_VERSION,
  agentError,
  type AgentError,
  type ConnectionAuth,
  type ConnectionMode,
  type ConnectionSummary,
  type ServiceEvent,
  type ServiceInfo,
  type ServiceSnapshot,
  type ScriptSummary,
  type ProjectSummary,
  type TimerSummary,
  type HealthStatus,
  type CloudStatus,
} from "@ballast/agent-protocol";
import { AgentRpcs } from "@ballast/agent-protocol";
import { AGENT_NAME } from "./config.ts";
import { CloudLink } from "./cloud-link.ts";
import { ConnectionManager } from "./connections.ts";
import { Lifecycle } from "./lifecycle.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import { scaffoldProject } from "./scaffold.ts";
import { ScriptManager } from "./scripts.ts";
import { EventLog, Logs, ServiceHub } from "./telemetry.ts";

export interface AgentRpcOptions {
  readonly stateDir: string;
  readonly dataDir: string;
  readonly startedAt: number;
  readonly version: string;
  readonly cloudUrl: string | undefined;
}

export const AgentRpcsLive = (options: AgentRpcOptions) => {
  const handlers = Effect.gen(function* () {
    const projects = yield* ProjectManager;
    const scripts = yield* ScriptManager;
    const runtime = yield* ProjectRuntime;
    const connections = yield* ConnectionManager;
    const cloud = yield* CloudLink;
    const lifecycle = yield* Lifecycle;
    const logs = yield* Logs;
    const events = yield* EventLog;
    const hub = yield* ServiceHub;

    const info = Effect.gen(function* () {
      const all = yield* projects.projects;
      const platform =
        process.platform === "darwin" || process.platform === "win32"
          ? process.platform
          : "linux";
      return {
        name: AGENT_NAME,
        version: options.version,
        apiVersion: AGENT_API_VERSION,
        pid: process.pid,
        startedAt: options.startedAt,
        ...(all[0] === undefined ? {} : { defaultProjectId: all[0].id }),
        stateDir: options.stateDir,
        dataDir: options.dataDir,
        platform,
        arch: process.arch,
        nodeVersion: process.version,
        capabilities: [
          "projects",
          "scripts",
          "connections",
          "cloud",
          "logs",
          "events",
          "consent",
        ],
      } satisfies ServiceInfo;
    });

    const health = Effect.gen(function* () {
      const counts = yield* scripts.counts;
      const projectCounts = yield* runtime.counts;
      const connectionList = yield* connections.summaries();
      const cloudStatus = yield* cloud.status;
      const projectList = yield* projects.projects;
      const lastLogSeq = yield* logs.lastSeq;
      const lastEventSeq = yield* events.lastSeq;
      const shellPermissions = yield* connections.permissions();
      return {
        ok: true,
        version: options.version,
        apiVersion: AGENT_API_VERSION,
        pid: process.pid,
        uptimeMs: Math.max(0, Date.now() - options.startedAt),
        projects: {
          total: projectList.length,
          running: projectCounts.running,
          needsConsent: projectCounts.needsConsent,
          error: projectCounts.error,
        },
        scripts: counts,
        connections: {
          total: connectionList.length,
          connected: connectionList.filter(
            (connection) => connection.status === "connected",
          ).length,
          error: connectionList.filter((connection) => connection.status === "error")
            .length,
        },
        cloud: cloudStatus.state,
        permissions: shellPermissions,
        lastLogSeq,
        lastEventSeq,
      } satisfies HealthStatus;
    });

    const projectScripts = (projectId: string) => scripts.summaries(projectId);

    const legacyProjectSummary = (
      project: ProjectRecord,
      projectScriptSummaries: ReadonlyArray<ScriptSummary>,
    ): ProjectSummary => {
      const status: ProjectSummary["status"] = projectScriptSummaries.some(
        (script) => script.status === "running",
      )
        ? "running"
        : projectScriptSummaries.some((script) => script.status === "needs-consent")
          ? "needs-consent"
          : projectScriptSummaries.some((script) => script.status === "error")
            ? "error"
            : "stopped";
      const lastError = projectScriptSummaries.find(
        (script) => script.lastError !== undefined,
      )?.lastError;
      return {
        id: project.id,
        name: project.name,
        root: project.root,
        entry: projectScriptSummaries[0]?.entry ?? "ballast.ts",
        enabled: projectScriptSummaries.some((script) => script.enabled),
        status,
        unitCount: 0,
        scriptCount: projectScriptSummaries.length,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ...(lastError === undefined ? {} : { lastError }),
      };
    };

    const projectSummary = (project: ProjectRecord) =>
      Effect.gen(function* () {
        const current = yield* runtime.summary(project.id);
        if (current !== undefined) return current;
        const projectScriptSummaries = yield* projectScripts(project.id);
        return legacyProjectSummary(project, projectScriptSummaries);
      });

    const projectDetail = (project: ProjectRecord) =>
      Effect.gen(function* () {
        const current = yield* runtime.summary(project.id);
        if (current !== undefined) return yield* runtime.detail(project.id);
        const projectScriptSummaries = yield* projectScripts(project.id);
        const summary = legacyProjectSummary(project, projectScriptSummaries);
        return {
          summary,
          manifest: {
            project: { id: project.id, entry: summary.entry ?? "ballast.ts" },
            params: [],
            connections: [],
            topics: [],
            requests: [],
            timers: [],
            workflows: [],
            runs: [],
            unresolved: [],
          },
          units: [],
          scripts: projectScriptSummaries,
        };
      });

    const publishHealth = health.pipe(
      Effect.flatMap((value) => hub.publish({ _tag: "health", health: value })),
    );

    const snapshot = Effect.gen(function* () {
      const projectList = yield* projects.projects;
      const scriptList = yield* scripts.summaries();
      const connectionList = yield* connections.summaries();
      const cloudStatus = yield* cloud.status;
      const consentList = yield* scripts.consents();
      const serviceInfo = yield* info;
      const serviceHealth = yield* health;
      const summaries = yield* Effect.forEach(projectList, (project) =>
        projectSummary(project),
      );
      return {
        info: serviceInfo,
        health: serviceHealth,
        projects: summaries,
        scripts: scriptList,
        connections: connectionList,
        cloud: cloudStatus,
        consents: consentList,
      } satisfies ServiceSnapshot;
    });

    const shutdown = (code: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Effect.forkDetach(
          Effect.sleep("100 millis").pipe(Effect.andThen(lifecycle.stop(code))),
        );
      });

    const requireProject = (projectId: string): Effect.Effect<ProjectRecord, AgentError> =>
      Effect.gen(function* () {
        const project = yield* projects.get(projectId);
        if (project === undefined) {
          return yield* Effect.fail(
            agentError("not-found", `No project "${projectId}"`),
          );
        }
        return project;
      });

    const toConnectionSummary = (value: ConnectionSummary): ConnectionSummary => value;

    return {
      GetServiceInfo: () => info,
      GetHealth: () => health,
      ShutdownService: () => shutdown(0),
      RestartService: () => shutdown(75),

      ReportShellPermission: (request: {
        readonly permission: "accessibility";
        readonly status: "granted" | "denied" | "unknown";
      }) =>
        Effect.gen(function* () {
          yield* connections.reportShellPermission(request);
          yield* publishHealth;
          for (const connection of yield* connections.summaries()) {
            if (connection.integration !== "keyboard") continue;
            yield* hub.publish({ _tag: "connection", connection });
          }
        }),

      ListProjects: () =>
        Effect.gen(function* () {
          const list = yield* projects.projects;
          const summaries = yield* Effect.forEach(list, (project) => projectSummary(project));
          return { projects: summaries };
        }),

      GetProject: ({ projectId }: { readonly projectId: string }) =>
        Effect.flatMap(requireProject(projectId), projectDetail),

      CreateProject: (request: {
        readonly name: string;
        readonly directory?: string;
      }) =>
        Effect.gen(function* () {
          const scaffolded = yield* scaffoldProject({
            name: request.name,
            ...(request.directory === undefined ? {} : { directory: request.directory }),
          });
          const project = yield* projects.add({
            path: scaffolded.root,
            name: scaffolded.name,
          });
          yield* scripts.syncProject(project.id);
          yield* runtime.syncProject(project.id);
          yield* hub.publish({ _tag: "project", project: yield* projectSummary(project) });
          yield* publishHealth;
          return yield* projectDetail(project);
        }),

      AddProject: (request: { readonly path: string; readonly name?: string }) =>
        Effect.gen(function* () {
          const project = yield* projects.add({
            path: request.path,
            ...(request.name === undefined ? {} : { name: request.name }),
          });
          yield* scripts.syncProject(project.id);
          yield* runtime.syncProject(project.id);
          const summary = yield* projectSummary(project);
          yield* hub.publish({ _tag: "project", project: summary });
          yield* publishHealth;
          return yield* projectDetail(project);
        }),

      RemoveProject: ({ projectId }: { readonly projectId: string }) =>
        Effect.gen(function* () {
          yield* requireProject(projectId);
          yield* scripts.removeProject(projectId);
          yield* runtime.removeProject(projectId);
          yield* projects.remove(projectId);
          yield* hub.publish({ _tag: "project-removed", projectId });
          yield* publishHealth;
        }),

      CheckProject: ({ projectId }: { readonly projectId: string }) => runtime.check(projectId),
      PlanProject: ({ projectId }: { readonly projectId: string }) => runtime.plan(projectId),
      StartProject: ({ projectId }: { readonly projectId: string }) => runtime.start(projectId),
      StopProject: ({ projectId }: { readonly projectId: string }) => runtime.stop(projectId),
      RestartProject: ({ projectId }: { readonly projectId: string }) => runtime.restart(projectId),
      SetProjectParam: (request: {
        readonly projectId: string;
        readonly key: string;
        readonly value: string | number | boolean;
      }) => runtime.setParam(request.projectId, request.key, request.value),
      SetProjectEnabled: (request: {
        readonly projectId: string;
        readonly enabled: boolean;
      }) => runtime.setEnabled(request.projectId, request.enabled),
      ListProjectFiles: ({ projectId }: { readonly projectId: string }) => runtime.files(projectId),
      ReadProjectFile: ({ projectId, path }: { readonly projectId: string; readonly path: string }) =>
        runtime.readFile(projectId, path),
      GetProjectSource: ({ projectId }: { readonly projectId: string }) =>
        runtime.entrySource(projectId),
      ListProjectConsents: (request: { readonly projectId?: string }) =>
        Effect.map(runtime.consents(request.projectId), (consents) => ({ consents })),
      ApproveProjectConsent: ({ consentId }: { readonly consentId: string }) =>
        runtime.approve(consentId),
      RejectProjectConsent: (request: { readonly consentId: string; readonly reason?: string }) =>
        runtime.reject(request.consentId, request.reason),

      ListScripts: (request: { readonly projectId?: string }) =>
        Effect.map(scripts.summaries(request.projectId), (list) => ({ scripts: list })),

      GetScript: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.detail(projectId, scriptId),

      GetScriptSource: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.source(projectId, scriptId),

      PlanScript: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.planScript(projectId, scriptId).pipe(Effect.flatMap(() => scripts.detail(projectId, scriptId))),

      StartScript: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.startScript(projectId, scriptId),

      StopScript: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.stopScript(projectId, scriptId),

      RestartScript: ({ projectId, scriptId }: { readonly projectId: string; readonly scriptId: string }) =>
        scripts.restartScript(projectId, scriptId),

      SetScriptParam: (request: {
        readonly projectId: string;
        readonly scriptId: string;
        readonly key: string;
        readonly value: string | number | boolean;
      }) => scripts.setParam(request.projectId, request.scriptId, request.key, request.value),

      SetScriptEnabled: (request: {
        readonly projectId: string;
        readonly scriptId: string;
        readonly enabled: boolean;
      }) => scripts.setEnabled(request.projectId, request.scriptId, request.enabled),

      ListTimers: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly includeFinished?: boolean;
      }) =>
        Effect.gen(function* () {
          const legacy = yield* scripts.listTimers(request);
          const project = yield* runtime.listTimers(request);
          const merged = new Map<string, TimerSummary>();
          for (const timer of [...legacy, ...project]) {
            merged.set(timer.projectId + "\u0000" + timer.timer + "\u0000" + timer.key, timer);
          }
          return { timers: [...merged.values()] };
        }),

      CancelTimer: (request: {
        readonly projectId: string;
        readonly scriptId?: string;
        readonly timer: string;
        readonly key: string;
      }) =>
        Effect.gen(function* () {
          const cancelled = yield* runtime.cancelTimer(request);
          if (cancelled) return { cancelled };
          return { cancelled: yield* scripts.cancelTimer(request) };
        }),

      ListConsents: (request: { readonly projectId?: string }) =>
        Effect.map(scripts.consents(request.projectId), (consents) => ({ consents })),

      ApproveConsent: ({ consentId }: { readonly consentId: string }) =>
        scripts.approve(consentId),

      RejectConsent: (request: { readonly consentId: string; readonly reason?: string }) =>
        scripts.reject(request.consentId, request.reason),

      ListConnections: () =>
        Effect.map(connections.summaries(), (list) => ({
          connections: list.map(toConnectionSummary),
        })),

      GetConnection: ({ connectionId }: { readonly connectionId: string }) =>
        connections.require(connectionId),

      ConfigureConnection: (request: {
        readonly connectionId: string;
        readonly values: ReadonlyArray<{ readonly key: string; readonly value: string }>;
        readonly mode?: ConnectionMode;
      }) => connections.configure(request),

      ConnectConnection: ({ connectionId }: { readonly connectionId: string }) =>
        connections.connect(connectionId),

      DisconnectConnection: ({ connectionId }: { readonly connectionId: string }) =>
        connections.disconnect(connectionId),

      StartConnectionAuth: (request: {
        readonly connectionId: string;
        readonly mode?: ConnectionMode;
        readonly scopes?: ReadonlyArray<string>;
      }): Effect.Effect<ConnectionAuth, AgentError> => connections.startAuth(request),

      GetCloudStatus: () => cloud.status,

      BeginCloudPairing: ({ machineName }: { readonly machineName: string }) =>
        cloud.beginPairing(machineName),

      PairCloud: ({ code, machineName }: { readonly code: string; readonly machineName: string }) =>
        cloud.pair(code, machineName),

      UnpairCloud: () => cloud.unpair(),

      StreamLogs: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly unitKind?: "topic" | "timer" | "workflow" | "param" | "run";
        readonly unitName?: string;
        readonly afterSeq?: number;
        readonly levels?: ReadonlyArray<"debug" | "info" | "warn" | "error">;
        readonly limit?: number;
      }) =>
        logs.stream({
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
          ...(request.unitKind === undefined ? {} : { unitKind: request.unitKind }),
          ...(request.unitName === undefined ? {} : { unitName: request.unitName }),
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
          ...(request.levels === undefined ? {} : { levels: request.levels }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        }),

      StreamEvents: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly unitKind?: "topic" | "timer" | "workflow" | "param" | "run";
        readonly unitName?: string;
        readonly integration?: string;
        readonly topic?: string;
        readonly afterSeq?: number;
        readonly limit?: number;
      }) =>
        events.stream({
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
          ...(request.unitKind === undefined ? {} : { unitKind: request.unitKind }),
          ...(request.unitName === undefined ? {} : { unitName: request.unitName }),
          ...(request.integration === undefined
            ? {}
            : { integration: request.integration }),
          ...(request.topic === undefined ? {} : { topic: request.topic }),
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        }),

      WatchService: () =>
        Stream.unwrap(
          Effect.map(snapshot, (value) =>
            Stream.concat(
              Stream.fromIterable<ServiceEvent>([{ _tag: "snapshot", snapshot: value }]),
              Stream.fromPubSub(hub.changes),
            ),
          ),
        ),
    };
  });

  return AgentRpcs.toLayer(handlers);
};

export type { CloudStatus };
