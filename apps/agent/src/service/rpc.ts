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
      const connectionList = yield* connections.summaries();
      const cloudStatus = yield* cloud.status;
      const projectList = yield* projects.projects;
      const lastLogSeq = yield* logs.lastSeq;
      const lastEventSeq = yield* events.lastSeq;
      return {
        ok: true,
        version: options.version,
        apiVersion: AGENT_API_VERSION,
        pid: process.pid,
        uptimeMs: Math.max(0, Date.now() - options.startedAt),
        projects: { total: projectList.length },
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
        lastLogSeq,
        lastEventSeq,
      } satisfies HealthStatus;
    });

    const projectScripts = (projectId: string) => scripts.summaries(projectId);

    const projectSummary = (project: ProjectRecord, scriptCount: number) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      scriptCount,
    });

    const projectDetail = (project: ProjectRecord) =>
      Effect.gen(function* () {
        const projectScriptSummaries = yield* projectScripts(project.id);
        return {
          summary: projectSummary(project, projectScriptSummaries.length),
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
        Effect.gen(function* () {
          const count = (yield* projectScripts(project.id)).length;
          return projectSummary(project, count);
        }),
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

      ListProjects: () =>
        Effect.gen(function* () {
          const list = yield* projects.projects;
          const summaries = yield* Effect.forEach(list, (project) =>
            Effect.gen(function* () {
              const count = (yield* projectScripts(project.id)).length;
              return projectSummary(project, count);
            }),
          );
          return { projects: summaries };
        }),

      GetProject: ({ projectId }: { readonly projectId: string }) =>
        Effect.flatMap(requireProject(projectId), projectDetail),

      AddProject: (request: { readonly path: string; readonly name?: string }) =>
        Effect.gen(function* () {
          const project = yield* projects.add({
            path: request.path,
            ...(request.name === undefined ? {} : { name: request.name }),
          });
          yield* scripts.syncProject(project.id);
          yield* hub.publish({
            _tag: "project",
            project: projectSummary(
              project,
              (yield* projectScripts(project.id)).length,
            ),
          });
          yield* publishHealth;
          return yield* projectDetail(project);
        }),

      RemoveProject: ({ projectId }: { readonly projectId: string }) =>
        Effect.gen(function* () {
          yield* requireProject(projectId);
          yield* scripts.removeProject(projectId);
          yield* projects.remove(projectId);
          yield* hub.publish({ _tag: "project-removed", projectId });
          yield* publishHealth;
        }),

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
        readonly afterSeq?: number;
        readonly levels?: ReadonlyArray<"debug" | "info" | "warn" | "error">;
        readonly limit?: number;
      }) =>
        logs.stream({
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
          ...(request.levels === undefined ? {} : { levels: request.levels }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        }),

      StreamEvents: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly integration?: string;
        readonly topic?: string;
        readonly afterSeq?: number;
        readonly limit?: number;
      }) =>
        events.stream({
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
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
