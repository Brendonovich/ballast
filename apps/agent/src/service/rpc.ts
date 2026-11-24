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
  type UnitKind,
  type ProjectSummary,
  type HealthStatus,
  type CloudStatus,
} from "@ballast/agent-protocol";
import { AgentRpcs } from "@ballast/agent-protocol";
import { AGENT_NAME } from "./config.ts";
import { ArtifactGateway } from "./artifact-gateway.ts";
import { CloudLink } from "./cloud-link.ts";
import { ConnectionManager } from "./connections.ts";
import { Lifecycle } from "./lifecycle.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import { ensureProjectTypes, scaffoldProject } from "./scaffold.ts";
import { EventHistory } from "./event-history.ts";
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
    const runtime = yield* ProjectRuntime;
    const artifacts = yield* ArtifactGateway;
    const connections = yield* ConnectionManager;
    const cloud = yield* CloudLink;
    const lifecycle = yield* Lifecycle;
    const logs = yield* Logs;
    const events = yield* EventLog;
    const history = yield* EventHistory;
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
          "connections",
          "cloud",
          "logs",
          "events",
          "consent",
        ],
      } satisfies ServiceInfo;
    });

    const health = Effect.gen(function* () {
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
          stopped: projectCounts.stopped,
          starting: projectCounts.starting,
          running: projectCounts.running,
          needsUser: projectCounts.needsUser,
          failed: projectCounts.failed,
          needsConsent: projectCounts.needsConsent,
          error: projectCounts.error,
        },
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

    const fallbackSummary = (project: ProjectRecord): ProjectSummary => ({
      id: project.id,
      name: project.name,
      root: project.root,
      entry: "ballast.ts",
      enabled: false,
      status: "stopped",
      unitCount: 0,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      issues: [],
    });

    const projectSummary = (project: ProjectRecord) =>
      Effect.map(runtime.summary(project.id), (summary) => summary ?? fallbackSummary(project));

    const projectDetail = (project: ProjectRecord) => runtime.detail(project.id);

    const publishHealth = health.pipe(
      Effect.flatMap((value) => hub.publish({ _tag: "health", health: value })),
    );

    const snapshot = Effect.gen(function* () {
      const projectList = yield* projects.projects;
      const connectionList = yield* connections.summaries();
      const cloudStatus = yield* cloud.status;
      const serviceInfo = yield* info;
      const serviceHealth = yield* health;
      const summaries = yield* Effect.forEach(projectList, (project) =>
        projectSummary(project),
      );
      return {
        info: serviceInfo,
        health: serviceHealth,
        projects: summaries,
        connections: connectionList,
        cloud: cloudStatus,
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
        readonly artifact?: boolean;
      }) =>
        Effect.gen(function* () {
          const typesDir = yield* ensureProjectTypes({
            dataDir: options.dataDir,
            version: options.version,
          });
          const scaffolded = yield* scaffoldProject({
            name: request.name,
            ...(request.directory === undefined ? {} : { directory: request.directory }),
            typesDir,
            ...(request.artifact === undefined ? {} : { artifact: request.artifact }),
          });
          const project = yield* projects.add({
            path: scaffolded.root,
            name: scaffolded.name,
          });
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
          yield* runtime.syncProject(project.id);
          const summary = yield* projectSummary(project);
          yield* hub.publish({ _tag: "project", project: summary });
          yield* publishHealth;
          return yield* projectDetail(project);
        }),

      RemoveProject: ({ projectId }: { readonly projectId: string }) =>
        Effect.gen(function* () {
          yield* requireProject(projectId);
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
        readonly value: string | number | boolean | ReadonlyArray<string>;
      }) => runtime.setParam(request.projectId, request.key, request.value),
      SetProjectEnabled: (request: {
        readonly projectId: string;
        readonly enabled: boolean;
      }) => runtime.setEnabled(request.projectId, request.enabled),
      SetProjectBinding: (request: {
        readonly projectId: string;
        readonly integration: string;
        readonly slot: string;
        readonly instanceId: string | null;
      }) => runtime.setBinding(request),
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

      ListTimers: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly includeFinished?: boolean;
      }) => Effect.map(runtime.listTimers(request), (timers) => ({ timers })),

      CancelTimer: (request: {
        readonly projectId: string;
        readonly scriptId?: string;
        readonly timer: string;
        readonly key: string;
      }) =>
        Effect.map(runtime.cancelTimer(request), (cancelled) => ({ cancelled })),

      ListIntegrations: () =>
        Effect.succeed({ integrations: connections.integrations() }),

      ListConnections: () =>
        Effect.map(connections.summaries(), (list) => ({
          connections: list.map(toConnectionSummary),
        })),

      CreateConnection: (request: {
        readonly integration: string;
        readonly label: string;
        readonly config: Readonly<Record<string, string>>;
        readonly mode?: ConnectionMode;
      }) => connections.create(request),

      UpdateConnection: (request: {
        readonly id: string;
        readonly label?: string;
        readonly config?: Readonly<Record<string, string>>;
        readonly mode?: ConnectionMode;
      }) => connections.update(request),

      DeleteConnection: ({ id }: { readonly id: string }) => connections.remove(id),

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

      ListCloudAccounts: () =>
        Effect.gen(function* () {
          const api = yield* cloud.api;
          if (api === undefined) {
            return yield* Effect.fail(
              agentError("conflict", "This machine is not linked to the Ballast cloud."),
            );
          }
          const connections = yield* api.listConnections.pipe(
            Effect.mapError((error) =>
              agentError(error.status === 401 ? "unauthorized" : "upstream", error.message),
            ),
          );
          return {
            accounts: connections.map((connection) => ({
              id: connection.id,
              login: connection.login,
              displayName: connection.displayName,
              scopes: [...connection.scopes],
              needsReauth: connection.needsReauth === true,
            })),
          };
        }),

      BeginCloudPairing: ({ machineName }: { readonly machineName: string }) =>
        cloud.beginPairing(machineName),

      PairCloud: ({ code, machineName }: { readonly code: string; readonly machineName: string }) =>
        cloud.pair(code, machineName),

      UnpairCloud: () => cloud.unpair(),

      ListArtifacts: ({ projectId }: { readonly projectId: string }) =>
        Effect.map(artifacts.listArtifacts(projectId), (artifacts) => ({ artifacts })),

      GetArtifactView: (request: {
        readonly projectId: string;
        readonly artifact: string;
      }) => artifacts.getView(request.projectId, request.artifact),

      RenewArtifactView: ({ token }: { readonly token: string }) =>
        artifacts.renewView(token),

      CreateArtifactUrl: (request: {
        readonly projectId: string;
        readonly artifact: string;
        readonly scope: "read" | "action";
        readonly transparent: boolean;
      }) => artifacts.createUrl(request),

      ListArtifactUrls: (request: {
        readonly projectId?: string;
        readonly artifact?: string;
      }) =>
        Effect.map(artifacts.listUrls(request), (urls) => ({ urls })),

      RevokeArtifactUrl: ({ id }: { readonly id: string }) =>
        artifacts.revokeUrl(id),

      ListArtifactUrlConfirmations: (request: {
        readonly projectId?: string;
      }) =>
        Effect.map(artifacts.listConfirmations(request.projectId), (confirmations) => ({
          confirmations,
        })),

      ApproveArtifactUrl: ({ confirmationId }: { readonly confirmationId: string }) =>
        artifacts.approveConfirmation(confirmationId),

      RejectArtifactUrl: ({ confirmationId }: { readonly confirmationId: string }) =>
        artifacts.rejectConfirmation(confirmationId),

      StreamLogs: (request: {
        readonly projectId?: string;
        readonly scriptId?: string;
        readonly unitKind?: UnitKind;
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
        readonly unitKind?: UnitKind;
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

      QueryEventHistory: (request: {
        readonly projectId: string;
        readonly subscription: string;
        readonly limit?: number;
        readonly before?: string;
      }) =>
        Effect.gen(function* () {
          const project = yield* projects.get(request.projectId);
          if (project === undefined) {
            return yield* Effect.fail(
              agentError("not-found", "No project " + request.projectId),
            );
          }
          const limit = Math.max(1, Math.min(Math.trunc(request.limit ?? 50), 500));
          const records = yield* history.query(project.id, request.subscription, {
            limit,
            ...(request.before === undefined ? {} : { before: request.before }),
          });
          const next = records[records.length - 1];
          return {
            entries: [...records],
            ...(records.length < limit || next === undefined
              ? {}
              : { nextCursor: next.cursor }),
          };
        }),

      ListEventHistorySubscriptions: (request: {
        readonly projectId: string;
        readonly subscription?: string;
      }) =>
        Effect.gen(function* () {
          const project = yield* projects.get(request.projectId);
          if (project === undefined) {
            return yield* Effect.fail(
              agentError("not-found", "No project " + request.projectId),
            );
          }
          const subscriptions = yield* history.subscriptions(project.id);
          return {
            subscriptions: subscriptions
              .filter(
                (subscription) =>
                  request.subscription === undefined ||
                  subscription.name === request.subscription,
              )
              .map((subscription) => ({
                name: subscription.name,
                integration: subscription.integration,
                slot: subscription.slot,
                topic: subscription.topic,
                history: subscription.policy !== false,
                ...(subscription.policy === false
                  ? {}
                  : {
                      maxEntries: subscription.policy.maxEntries,
                      retentionMs: subscription.policy.retentionMs,
                    }),
              })),
          };
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
