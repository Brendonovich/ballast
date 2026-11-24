import type {
  ArtifactSummary,
  ArtifactUrlConfirmation,
  ArtifactUrlSummary,
  ArtifactView,
  CloudPairingSession,
  CloudStatus,
  CloudTwitchAccount,
  CreateArtifactUrlResult,
  ConnectionAuth,
  ConnectionIntegration,
  ConnectionMode,
  ConnectionSummary,
  HealthStatus,
  LogEntry,
  ParamValue,
  PermissionStatus,
  ProjectConsentRequest,
  ProjectDetail,
  ProjectFileContent,
  ProjectSummary,
  RenewArtifactViewResponse,
  ServiceEvent,
  ServiceInfo,
  ServiceSnapshot,
  TimerSummary,
} from "@ballast/agent-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";

import type { AgentRuntime, TransportConfig } from "../agent/client.ts";
import { runResilient } from "../agent/client.ts";
import { errorMessage } from "../agent/errors.ts";

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface CreateAgentStoreOptions {
  readonly onError?: (message: string) => void;
  /** Project whose logs this window subscribes to; absent for home windows. */
  readonly logProjectId?: string;
}

export interface AgentStore {
  readonly transport: TransportConfig;
  readonly snapshot: Accessor<ServiceSnapshot | undefined>;
  readonly info: Accessor<ServiceInfo | undefined>;
  readonly health: Accessor<HealthStatus | undefined>;
  readonly watchStatus: Accessor<StreamStatus>;
  readonly logStatus: Accessor<StreamStatus>;
  readonly lastActionError: Accessor<string | undefined>;
  readonly logs: Accessor<ReadonlyArray<LogEntry>>;
  readonly pending: Accessor<ReadonlyArray<string>>;
  readonly setLogProject: (projectId: string | undefined) => void;
  /**
   * Append a line as if the service had streamed it. Used by the mock-mode
   * dev hook so e2e tests can produce project log lines on demand.
   */
  readonly receiveLog: (entry: LogEntry) => void;
  readonly projects: () => ReadonlyArray<ProjectSummary>;
  readonly project: (projectId: string) => ProjectSummary | undefined;
  readonly projectDetail: (projectId: string) => ProjectDetail | undefined;
  readonly projectErrorMessage: (projectId: string) => string | undefined;
  readonly projectConsent: (projectId: string) => ProjectConsentRequest | undefined;
  readonly projectRevision: (projectId: string) => number;
  readonly projectFileRevision: (projectId: string) => number;
  readonly integrations: Accessor<ReadonlyArray<ConnectionIntegration>>;
  readonly loadIntegrations: () => Promise<void>;
  readonly artifacts: (projectId: string) => ReadonlyArray<ArtifactSummary>;
  readonly artifactRevision: (projectId: string, artifact: string) => number;
  readonly artifactListRevision: (projectId: string) => number;
  readonly artifactUrlRevision: Accessor<number>;
  readonly fetchArtifacts: (
    projectId: string,
    force?: boolean,
  ) => Promise<ReadonlyArray<ArtifactSummary> | undefined>;
  readonly getArtifactView: (
    projectId: string,
    artifact: string,
  ) => Promise<ArtifactView | undefined>;
  readonly renewArtifactView: (
    token: string,
  ) => Promise<RenewArtifactViewResponse | undefined>;
  readonly createArtifactUrl: (request: {
    readonly projectId: string;
    readonly artifact: string;
    readonly scope: "read" | "action";
    readonly transparent: boolean;
  }) => Promise<CreateArtifactUrlResult | undefined>;
  readonly listArtifactUrls: (
    projectId: string,
    artifact: string,
  ) => Promise<ReadonlyArray<ArtifactUrlSummary> | undefined>;
  readonly revokeArtifactUrl: (id: string) => Promise<boolean>;
  readonly listArtifactUrlConfirmations: (
    projectId: string,
  ) => Promise<ReadonlyArray<ArtifactUrlConfirmation> | undefined>;
  readonly approveArtifactUrl: (
    confirmationId: string,
  ) => Promise<{ readonly url: ArtifactUrlSummary; readonly copyUrl: string } | undefined>;
  readonly rejectArtifactUrl: (confirmationId: string) => Promise<boolean>;
  readonly cloudAccounts: Accessor<ReadonlyArray<CloudTwitchAccount>>;
  readonly loadCloudAccounts: () => Promise<void>;
  readonly connections: () => ReadonlyArray<ConnectionSummary>;
  readonly connection: (connectionId: string) => ConnectionSummary | undefined;
  readonly cloud: () => CloudStatus | undefined;
  readonly start: () => void;
  readonly whenReady: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly isPending: (key: string) => boolean;
  readonly isProjectLoading: (projectId: string) => boolean;
  readonly clearActionError: () => void;
  readonly refresh: () => Promise<boolean>;
  readonly refreshProjectConsents: () => Promise<void>;
  readonly fetchProject: (projectId: string, force?: boolean) => Promise<ProjectDetail | undefined>;
  readonly createProject: (
    name: string,
    directory?: string,
  ) => Promise<ProjectDetail | undefined>;
  readonly addProject: (
    path: string,
    name?: string,
  ) => Promise<ProjectDetail | undefined>;
  readonly removeProject: (projectId: string) => Promise<boolean>;
  readonly startProject: (projectId: string) => Promise<ProjectDetail | undefined>;
  readonly stopProject: (projectId: string) => Promise<ProjectDetail | undefined>;
  readonly restartProject: (projectId: string) => Promise<ProjectDetail | undefined>;
  readonly setProjectParam: (
    projectId: string,
    key: string,
    value: ParamValue,
  ) => Promise<ProjectDetail | undefined>;
  readonly approveProjectConsent: (
    consentId: string,
  ) => Promise<ProjectDetail | undefined>;
  readonly rejectProjectConsent: (
    consentId: string,
  ) => Promise<ProjectDetail | undefined>;
  readonly listProjectFiles: (
    projectId: string,
  ) => Promise<{ readonly entry: string; readonly files: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }> } | undefined>;
  readonly readProjectFile: (
    projectId: string,
    path: string,
  ) => Promise<ProjectFileContent | undefined>;
  readonly listTimers: (projectId: string) => Promise<ReadonlyArray<TimerSummary> | undefined>;
  readonly cancelTimer: (
    projectId: string,
    timer: string,
    key: string,
  ) => Promise<boolean>;
  readonly setProjectBinding: (
    projectId: string,
    integration: string,
    slot: string,
    instanceId: string | null,
  ) => Promise<ProjectDetail | undefined>;
  readonly createConnection: (request: {
    readonly integration: string;
    readonly label: string;
    readonly config: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }) => Promise<ConnectionSummary | undefined>;
  readonly updateConnection: (request: {
    readonly id: string;
    readonly label?: string;
    readonly config?: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }) => Promise<ConnectionSummary | undefined>;
  readonly deleteConnection: (connectionId: string) => Promise<boolean>;
  readonly configureConnection: (
    connectionId: string,
    values: ReadonlyArray<{ readonly key: string; readonly value: string }>,
    mode?: ConnectionMode,
  ) => Promise<ConnectionSummary | undefined>;
  readonly connectConnection: (
    connectionId: string,
  ) => Promise<ConnectionSummary | undefined>;
  readonly disconnectConnection: (
    connectionId: string,
  ) => Promise<ConnectionSummary | undefined>;
  readonly startConnectionAuth: (
    connectionId: string,
    mode?: ConnectionMode,
    scopes?: ReadonlyArray<string>,
  ) => Promise<ConnectionAuth | undefined>;
  readonly beginCloudPairing: (
    machineName: string,
  ) => Promise<CloudPairingSession | undefined>;
  readonly pairCloud: (code: string, machineName: string) => Promise<CloudStatus | undefined>;
  readonly unpairCloud: () => Promise<CloudStatus | undefined>;
  readonly reportShellPermission: (
    permission: "accessibility",
    status: PermissionStatus,
  ) => Promise<boolean>;
  readonly shutdownService: (force?: boolean) => Promise<boolean>;
}

const upsertBy = <A>(
  items: ReadonlyArray<A>,
  item: A,
  key: (value: A) => string,
): ReadonlyArray<A> => {
  const index = items.findIndex((candidate) => key(candidate) === key(item));
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
};

const removeBy = <A>(
  items: ReadonlyArray<A>,
  predicate: (value: A) => boolean,
): ReadonlyArray<A> => items.filter((item) => !predicate(item));

type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/**
 * The single reactive source of truth for the UI. `WatchService` supplies the
 * snapshot and incremental events, `StreamLogs` fills the log buffer, and
 * project mutations write their returned detail straight back.
 */
export const createAgentStore = (
  runtime: AgentRuntime,
  options: CreateAgentStoreOptions = {},
): AgentStore => {
  const [snapshot, setSnapshot] = createSignal<ServiceSnapshot>();
  const [integrations, setIntegrations] = createSignal<ReadonlyArray<ConnectionIntegration>>([]);
  const [cloudAccounts, setCloudAccounts] = createSignal<ReadonlyArray<CloudTwitchAccount>>([]);
  const [artifactsByProject, setArtifactsByProject] = createSignal<
    Readonly<Record<string, ReadonlyArray<ArtifactSummary>>>
  >({});
  const [artifactRevisions, setArtifactRevisions] = createSignal<
    Readonly<Record<string, number>>
  >({});
  const [artifactListRevisions, setArtifactListRevisions] = createSignal<
    Readonly<Record<string, number>>
  >({});
  const [artifactUrlRevision, setArtifactUrlRevision] = createSignal(0);
  const [watchStatus, setWatchStatus] = createSignal<StreamStatus>("connecting");
  const [logStatus, setLogStatus] = createSignal<StreamStatus>("connecting");
  const [lastActionError, setLastActionError] = createSignal<string>();
  const [logs, setLogs] = createSignal<ReadonlyArray<LogEntry>>([]);
  const [logProjectId, setLogProjectId] = createSignal<string | undefined>(
    options.logProjectId,
  );
  const [projectDetails, setProjectDetails] = createSignal<
    Readonly<Record<string, ProjectDetail>>
  >({});
  const [projectLoading, setProjectLoading] = createSignal<ReadonlyArray<string>>([]);
  const [projectErrors, setProjectErrors] = createSignal<Readonly<Record<string, string>>>({});
  const [projectConsents, setProjectConsents] = createSignal<
    Readonly<Record<string, ProjectConsentRequest>>
  >({});
  const [projectRevisions, setProjectRevisions] = createSignal<Readonly<Record<string, number>>>(
    {},
  );
  const [projectFileRevisions, setProjectFileRevisions] = createSignal<
    Readonly<Record<string, number>>
  >({});
  const [pending, setPending] = createSignal<ReadonlyArray<string>>([]);

  const handles: Array<() => void> = [];
  let logHandle: (() => void) | undefined;
  const inFlightProjects = new Map<string, Promise<ProjectDetail | undefined>>();
  let started = false;
  let disposed = false;
  let lastLogSeq = 0;
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const notifyError = (message: string): void => {
    setLastActionError(message);
    options.onError?.(message);
  };

  const markPending = (key: string, on: boolean): void => {
    setPending((current) =>
      on
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((entry) => entry !== key),
    );
  };

  const execute = async <A, E>(
    key: string,
    effect: Effect.Effect<A, E>,
  ): Promise<Outcome<A>> => {
    markPending(key, true);
    try {
      return { ok: true, value: await runtime.run(effect) };
    } catch (error) {
      const message = errorMessage(error);
      notifyError(message);
      return { ok: false, message };
    } finally {
      markPending(key, false);
    }
  };

  const projects = (): ReadonlyArray<ProjectSummary> => snapshot()?.projects ?? [];
  const project = (projectId: string): ProjectSummary | undefined =>
    projects().find((entry) => entry.id === projectId);
  const projectDetail = (projectId: string): ProjectDetail | undefined =>
    projectDetails()[projectId];
  const projectErrorMessage = (projectId: string): string | undefined =>
    projectErrors()[projectId];
  const projectConsent = (projectId: string): ProjectConsentRequest | undefined =>
    projectConsents()[projectId];
  const projectRevision = (projectId: string): number => projectRevisions()[projectId] ?? 0;
  const artifacts = (projectId: string): ReadonlyArray<ArtifactSummary> =>
    artifactsByProject()[projectId] ?? [];
  const artifactRevision = (projectId: string, artifact: string): number =>
    artifactRevisions()[`${projectId}\u0000${artifact}`] ?? 0;
  const artifactListRevision = (projectId: string): number =>
    artifactListRevisions()[projectId] ?? 0;
  const projectFileRevision = (projectId: string): number =>
    projectFileRevisions()[projectId] ?? 0;
  const connections = (): ReadonlyArray<ConnectionSummary> =>
    snapshot()?.connections ?? [];
  const connection = (connectionId: string): ConnectionSummary | undefined =>
    connections().find((entry) => entry.id === connectionId);
  const cloud = (): CloudStatus | undefined => snapshot()?.cloud;

  const readyNow = (): void => {
    readyResolve?.();
    readyResolve = undefined;
  };

  const upsertSummary = (summary: ProjectSummary): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        projects: upsertBy(current.projects, summary, (entry) => entry.id),
      };
    });
  };

  const bumpRevision = (projectId: string): void => {
    setProjectRevisions((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? 0) + 1,
    }));
  };

  const bumpFileRevision = (projectId: string): void => {
    setProjectFileRevisions((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? 0) + 1,
    }));
  };

  const setProjectConsent = (consent: ProjectConsentRequest | undefined): void => {
    if (consent === undefined) return;
    setProjectConsents((current) => ({ ...current, [consent.projectId]: consent }));
  };

  const clearProjectConsent = (projectId: string): void => {
    setProjectConsents((current) => {
      if (current[projectId] === undefined) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  };

  const applyProjectDetail = (detail: ProjectDetail): void => {
    setProjectDetails((current) => ({ ...current, [detail.summary.id]: detail }));
    upsertSummary(detail.summary);
    if (detail.pendingConsent === undefined) clearProjectConsent(detail.summary.id);
    else setProjectConsent(detail.pendingConsent);
    setProjectErrors((current) => {
      if (current[detail.summary.id] === undefined) return current;
      const next = { ...current };
      delete next[detail.summary.id];
      return next;
    });
  };

  const removeProjectState = (projectId: string): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        projects: removeBy(current.projects, (entry) => entry.id === projectId),
        connections: current.connections.map((connection) => ({
          ...connection,
          boundBy: connection.boundBy.filter((ref) => ref.projectId !== projectId),
        })),
      };
    });
    setProjectDetails((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    setArtifactsByProject((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    clearProjectConsent(projectId);
  };

  const applyLocalBinding = (
    projectId: string,
    slot: string,
    instanceId: string | null,
  ): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        connections: current.connections.map((connection) => {
          const boundBy = connection.boundBy.filter(
            (ref) => !(ref.projectId === projectId && ref.slot === slot),
          );
          return connection.id === instanceId
            ? { ...connection, boundBy: [...boundBy, { projectId, slot }] }
            : { ...connection, boundBy };
        }),
      };
    });
  };

  const upsertConnection = (entry: ConnectionSummary): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        connections: upsertBy(current.connections, entry, (candidate) => candidate.id),
      };
    });
  };

  const setCloud = (entry: CloudStatus): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return { ...current, cloud: entry };
    });
  };

  const applyEvent = (event: ServiceEvent): void => {
    switch (event._tag) {
      case "snapshot": {
        setSnapshot(event.snapshot);
        setWatchStatus("live");
        for (const entry of event.snapshot.projects) bumpRevision(entry.id);
        readyNow();
        return;
      }
      case "project": {
        upsertSummary(event.project);
        bumpRevision(event.project.id);
        bumpFileRevision(event.project.id);
        return;
      }
      case "project-changed": {
        upsertSummary(event.project);
        bumpRevision(event.project.id);
        bumpFileRevision(event.project.id);
        return;
      }
      case "reload-failed": {
        bumpRevision(event.projectId);
        bumpFileRevision(event.projectId);
        return;
      }
      case "project-file-changed": {
        bumpFileRevision(event.projectId);
        return;
      }
      case "project-consent": {
        setProjectConsent(event.consent);
        bumpRevision(event.consent.projectId);
        return;
      }
      case "project-consent-resolved": {
        clearProjectConsent(event.projectId);
        upsertSummary(event.project);
        bumpRevision(event.projectId);
        return;
      }
      case "project-removed": {
        removeProjectState(event.projectId);
        return;
      }
      case "artifact-changed": {
        const key = `${event.projectId}\u0000${event.artifact}`;
        setArtifactRevisions((current) => ({
          ...current,
          [key]: (current[key] ?? 0) + 1,
        }));
        setArtifactListRevisions((current) => ({
          ...current,
          [event.projectId]: (current[event.projectId] ?? 0) + 1,
        }));
        return;
      }
      case "artifact-url":
      case "artifact-url-confirmation":
      case "artifact-url-confirmation-resolved": {
        setArtifactUrlRevision((current) => current + 1);
        return;
      }
      case "connection": {
        upsertConnection(event.connection);
        return;
      }
      case "cloud": {
        setCloud(event.cloud);
        return;
      }
      case "health": {
        setSnapshot((current) =>
          current === undefined ? current : { ...current, health: event.health },
        );
        return;
      }
      default:
        return;
    }
  };

  const stopLogs = (): void => {
    logHandle?.();
    logHandle = undefined;
  };

  const appendLog = (entry: LogEntry): void => {
    setLogs((current) => {
      const next = [...current, entry];
      return next.length > 2_000 ? next.slice(next.length - 2_000) : next;
    });
  };

  const startLogs = (): void => {
    stopLogs();
    setLogs([]);
    lastLogSeq = 0;
    const projectId = logProjectId();
    if (projectId === undefined) {
      setLogStatus("live");
      return;
    }
    setLogStatus("connecting");
    logHandle = runtime.start(
      runResilient(
        Effect.gen(function* () {
          while (snapshot() === undefined) {
            yield* Effect.sleep("50 millis");
          }
          const request = {
            projectId,
            ...(lastLogSeq === 0 ? {} : { afterSeq: lastLogSeq }),
          };
          yield* runtime.client.StreamLogs(request).pipe(
            Stream.onStart(Effect.sync(() => setLogStatus("live"))),
            Stream.runForEach((entry) =>
              Effect.sync(() => {
                if (entry.seq <= lastLogSeq) return;
                lastLogSeq = entry.seq;
                setLogStatus("live");
                appendLog(entry);
              }),
            ),
          );
        }),
        () => {
          setLogStatus("reconnecting");
        },
      ),
    );
  };

  const start = (): void => {
    if (started || disposed) return;
    started = true;

    handles.push(
      runtime.start(
        runResilient(
          runtime.client.WatchService({}).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                applyEvent(event);
              }),
            ),
          ),
          (error) => {
            setWatchStatus("reconnecting");
            setLastActionError(`Service connection lost: ${errorMessage(error)}`);
          },
        ),
      ),
    );

    startLogs();
  };

  const setLogProject = (projectId: string | undefined): void => {
    if (logProjectId() === projectId) return;
    setLogProjectId(projectId);
    if (started && !disposed) startLogs();
  };

  const whenReady = (): Promise<void> => ready;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    stopLogs();
    for (const interrupt of handles.splice(0)) interrupt();
    await runtime.dispose();
  };

  const fetchArtifacts = async (
    projectId: string,
    force = false,
  ): Promise<ReadonlyArray<ArtifactSummary> | undefined> => {
    if (!force && artifactsByProject()[projectId] !== undefined) {
      return artifactsByProject()[projectId];
    }
    const outcome = await execute(
      `artifacts:${projectId}:list`,
      runtime.client.ListArtifacts({ projectId }),
    );
    if (!outcome.ok) return undefined;
    setArtifactsByProject((current) => ({
      ...current,
      [projectId]: outcome.value.artifacts,
    }));
    return outcome.value.artifacts;
  };

  const getArtifactView = async (
    projectId: string,
    artifact: string,
  ): Promise<ArtifactView | undefined> => {
    const outcome = await execute(
      `artifacts:${projectId}:${artifact}:view`,
      runtime.client.GetArtifactView({ projectId, artifact }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const renewArtifactView = async (
    token: string,
  ): Promise<RenewArtifactViewResponse | undefined> => {
    // A token can disappear across a service restart. The viewer falls back to
    // a fresh view, so a failed renewal should not surface an error toast.
    try {
      return await runtime.run(runtime.client.RenewArtifactView({ token }));
    } catch {
      return undefined;
    }
  };

  const createArtifactUrl = async (request: {
    readonly projectId: string;
    readonly artifact: string;
    readonly scope: "read" | "action";
    readonly transparent: boolean;
  }): Promise<CreateArtifactUrlResult | undefined> => {
    const outcome = await execute(
      `artifacts:${request.projectId}:${request.artifact}:url:create`,
      runtime.client.CreateArtifactUrl(request),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const listArtifactUrls = async (
    projectId: string,
    artifact: string,
  ): Promise<ReadonlyArray<ArtifactUrlSummary> | undefined> => {
    const outcome = await execute(
      `artifacts:${projectId}:${artifact}:urls`,
      runtime.client.ListArtifactUrls({ projectId, artifact }),
    );
    return outcome.ok ? outcome.value.urls : undefined;
  };

  const revokeArtifactUrl = async (id: string): Promise<boolean> => {
    const outcome = await execute(
      `artifacts:url:${id}:revoke`,
      runtime.client.RevokeArtifactUrl({ id }),
    );
    return outcome.ok;
  };

  const listArtifactUrlConfirmations = async (
    projectId: string,
  ): Promise<ReadonlyArray<ArtifactUrlConfirmation> | undefined> => {
    const outcome = await execute(
      `artifacts:${projectId}:url:confirmations`,
      runtime.client.ListArtifactUrlConfirmations({ projectId }),
    );
    return outcome.ok ? outcome.value.confirmations : undefined;
  };

  const approveArtifactUrl = async (
    confirmationId: string,
  ): Promise<{ readonly url: ArtifactUrlSummary; readonly copyUrl: string } | undefined> => {
    const outcome = await execute(
      `artifacts:url:${confirmationId}:approve`,
      runtime.client.ApproveArtifactUrl({ confirmationId }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const rejectArtifactUrl = async (confirmationId: string): Promise<boolean> => {
    const outcome = await execute(
      `artifacts:url:${confirmationId}:reject`,
      runtime.client.RejectArtifactUrl({ confirmationId }),
    );
    return outcome.ok;
  };

  const loadCloudAccounts = async (): Promise<void> => {
    const outcome = await execute(
      "cloud:accounts",
      runtime.client.ListCloudAccounts(),
    );
    if (outcome.ok) setCloudAccounts(outcome.value.accounts);
  };

  const loadIntegrations = async (): Promise<void> => {
    const outcome = await execute(
      "integrations:list",
      runtime.client.ListIntegrations(),
    );
    if (outcome.ok) setIntegrations(outcome.value.integrations);
  };

  const refresh = async (): Promise<boolean> => {
    const outcome = await execute(
      "service:refresh",
      Effect.gen(function* () {
        const info = yield* runtime.client.GetServiceInfo();
        const health = yield* runtime.client.GetHealth();
        const projectList = yield* runtime.client.ListProjects();
        const integrationList = yield* runtime.client.ListIntegrations();
        const projectConsentList =
          runtime.transport.kind === "mock"
            ? { consents: [] }
            : yield* runtime.client.ListProjectConsents({});
        const connectionList = yield* runtime.client.ListConnections();
        const cloudStatus = yield* runtime.client.GetCloudStatus();
        return {
          info,
          health,
          projectList,
          integrationList,
          projectConsentList,
          connectionList,
          cloudStatus,
        };
      }),
    );
    if (!outcome.ok) return false;
    setIntegrations(outcome.value.integrationList.integrations);
    const consents: Record<string, ProjectConsentRequest> = {};
    for (const consent of outcome.value.projectConsentList.consents) {
      consents[consent.projectId] = consent;
    }
    setProjectConsents(consents);
    const next: ServiceSnapshot = {
      info: outcome.value.info,
      health: outcome.value.health,
      projects: outcome.value.projectList.projects,
      connections: outcome.value.connectionList.connections,
      cloud: outcome.value.cloudStatus,
    };
    setSnapshot(next);
    setWatchStatus("live");
    readyNow();
    return true;
  };

  const refreshProjectConsents = async (): Promise<void> => {
    if (runtime.transport.kind === "mock") return;
    const outcome = await execute(
      "project-consents:list",
      runtime.client.ListProjectConsents({}),
    );
    if (!outcome.ok) return;
    const consents: Record<string, ProjectConsentRequest> = {};
    for (const consent of outcome.value.consents) consents[consent.projectId] = consent;
    setProjectConsents(consents);
  };

  const fetchProject = async (
    projectId: string,
    force = false,
  ): Promise<ProjectDetail | undefined> => {
    if (!force) {
      const cached = projectDetails()[projectId];
      if (cached !== undefined) return cached;
    }
    const existing = inFlightProjects.get(projectId);
    if (existing !== undefined) return existing;

    const promise = (async (): Promise<ProjectDetail | undefined> => {
      setProjectLoading((current) =>
        current.includes(projectId) ? current : [...current, projectId],
      );
      const outcome = await execute(
        `project:${projectId}:load`,
        runtime.client.GetProject({ projectId }),
      );
      setProjectLoading((current) => current.filter((entry) => entry !== projectId));
      if (!outcome.ok) {
        setProjectErrors((current) => ({ ...current, [projectId]: outcome.message }));
        return undefined;
      }
      applyProjectDetail(outcome.value);
      return outcome.value;
    })();

    inFlightProjects.set(projectId, promise);
    try {
      return await promise;
    } finally {
      inFlightProjects.delete(projectId);
    }
  };

  const createProject = async (
    name: string,
    directory?: string,
  ): Promise<ProjectDetail | undefined> => {
    const outcome = await execute(
      "project:create",
      runtime.client.CreateProject({
        name,
        ...(directory === undefined || directory.trim() === ""
          ? {}
          : { directory: directory.trim() }),
      }),
    );
    if (!outcome.ok) return undefined;
    applyProjectDetail(outcome.value);
    return outcome.value;
  };

  const addProject = async (
    path: string,
    name?: string,
  ): Promise<ProjectDetail | undefined> => {
    const outcome = await execute(
      "project:add",
      runtime.client.AddProject({
        path,
        ...(name === undefined || name.trim() === "" ? {} : { name }),
      }),
    );
    if (!outcome.ok) return undefined;
    applyProjectDetail(outcome.value);
    return outcome.value;
  };

  const removeProject = async (projectId: string): Promise<boolean> => {
    const outcome = await execute(
      "project:remove",
      runtime.client.RemoveProject({ projectId }),
    );
    if (!outcome.ok) return false;
    removeProjectState(projectId);
    return true;
  };

  const runProjectAction = async (
    key: string,
    effect: Effect.Effect<ProjectDetail, unknown>,
  ): Promise<ProjectDetail | undefined> => {
    const outcome = await execute(key, effect);
    if (!outcome.ok) return undefined;
    applyProjectDetail(outcome.value);
    bumpRevision(projectIdOfDetail(outcome.value));
    return outcome.value;
  };

  const projectIdOfDetail = (detail: ProjectDetail): string => detail.summary.id;

  const startProject = (projectId: string): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project:${projectId}:start`,
      runtime.client.StartProject({ projectId }),
    );

  const stopProject = (projectId: string): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project:${projectId}:stop`,
      runtime.client.StopProject({ projectId }),
    );

  const restartProject = (projectId: string): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project:${projectId}:restart`,
      runtime.client.RestartProject({ projectId }),
    );

  const setProjectParam = (
    projectId: string,
    key: string,
    value: ParamValue,
  ): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project:${projectId}:param:${key}`,
      runtime.client.SetProjectParam({ projectId, key, value }),
    );

  const approveProjectConsent = (consentId: string): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project-consent:${consentId}:approve`,
      runtime.client.ApproveProjectConsent({ consentId }),
    );

  const rejectProjectConsent = (consentId: string): Promise<ProjectDetail | undefined> =>
    runProjectAction(
      `project-consent:${consentId}:reject`,
      runtime.client.RejectProjectConsent({ consentId }),
    );

  const listProjectFiles = async (
    projectId: string,
  ): Promise<{ readonly entry: string; readonly files: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }> } | undefined> => {
    const outcome = await execute(
      `project:${projectId}:files`,
      runtime.client.ListProjectFiles({ projectId }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const readProjectFile = async (
    projectId: string,
    path: string,
  ): Promise<ProjectFileContent | undefined> => {
    const outcome = await execute(
      `project:${projectId}:file:${path}`,
      runtime.client.ReadProjectFile({ projectId, path }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const listTimers = async (
    projectId: string,
  ): Promise<ReadonlyArray<TimerSummary> | undefined> => {
    const outcome = await execute(
      `project:${projectId}:timers`,
      runtime.client.ListTimers({ projectId }),
    );
    return outcome.ok ? outcome.value.timers : undefined;
  };

  const cancelTimer = async (
    projectId: string,
    timer: string,
    key: string,
  ): Promise<boolean> => {
    const outcome = await execute(
      `project:${projectId}:timer:${timer}:${key}:cancel`,
      runtime.client.CancelTimer({ projectId, timer, key }),
    );
    return outcome.ok ? outcome.value.cancelled : false;
  };

  const setProjectBinding = async (
    projectId: string,
    integration: string,
    slot: string,
    instanceId: string | null,
  ): Promise<ProjectDetail | undefined> => {
    const outcome = await execute(
      `project:${projectId}:binding:${integration}:${slot}`,
      runtime.client.SetProjectBinding({ projectId, integration, slot, instanceId }),
    );
    if (!outcome.ok) return undefined;
    applyProjectDetail(outcome.value);
    applyLocalBinding(projectId, slot, instanceId);
    bumpRevision(projectId);
    return outcome.value;
  };

  const createConnection = async (request: {
    readonly integration: string;
    readonly label: string;
    readonly config: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }): Promise<ConnectionSummary | undefined> => {
    const outcome = await execute(
      "connection:create",
      runtime.client.CreateConnection(request),
    );
    if (!outcome.ok) return undefined;
    upsertConnection(outcome.value);
    return outcome.value;
  };

  const updateConnection = async (request: {
    readonly id: string;
    readonly label?: string;
    readonly config?: Readonly<Record<string, string>>;
    readonly mode?: ConnectionMode;
  }): Promise<ConnectionSummary | undefined> => {
    const outcome = await execute(
      `connection:${request.id}:update`,
      runtime.client.UpdateConnection(request),
    );
    if (!outcome.ok) return undefined;
    upsertConnection(outcome.value);
    return outcome.value;
  };

  const deleteConnection = async (connectionId: string): Promise<boolean> => {
    const outcome = await execute(
      `connection:${connectionId}:delete`,
      runtime.client.DeleteConnection({ id: connectionId }),
    );
    if (!outcome.ok) return false;
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        connections: removeBy(current.connections, (entry) => entry.id === connectionId),
      };
    });
    return true;
  };

  const configureConnection = async (
    connectionId: string,
    values: ReadonlyArray<{ readonly key: string; readonly value: string }>,
    mode?: ConnectionMode,
  ): Promise<ConnectionSummary | undefined> => {
    const outcome = await execute(
      `connection:${connectionId}:configure`,
      runtime.client.ConfigureConnection({
        connectionId,
        values,
        ...(mode === undefined ? {} : { mode }),
      }),
    );
    if (!outcome.ok) return undefined;
    upsertConnection(outcome.value);
    return outcome.value;
  };

  const connectConnection = async (
    connectionId: string,
  ): Promise<ConnectionSummary | undefined> => {
    const outcome = await execute(
      `connection:${connectionId}:connect`,
      runtime.client.ConnectConnection({ connectionId }),
    );
    if (!outcome.ok) return undefined;
    upsertConnection(outcome.value);
    return outcome.value;
  };

  const disconnectConnection = async (
    connectionId: string,
  ): Promise<ConnectionSummary | undefined> => {
    const outcome = await execute(
      `connection:${connectionId}:disconnect`,
      runtime.client.DisconnectConnection({ connectionId }),
    );
    if (!outcome.ok) return undefined;
    upsertConnection(outcome.value);
    return outcome.value;
  };

  const startConnectionAuth = async (
    connectionId: string,
    mode?: ConnectionMode,
    scopes?: ReadonlyArray<string>,
  ): Promise<ConnectionAuth | undefined> => {
    const outcome = await execute(
      `connection:${connectionId}:auth`,
      runtime.client.StartConnectionAuth({
        connectionId,
        ...(mode === undefined ? {} : { mode }),
        ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
      }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const beginCloudPairing = async (
    machineName: string,
  ): Promise<CloudPairingSession | undefined> => {
    const outcome = await execute(
      "cloud:begin",
      runtime.client.BeginCloudPairing({ machineName }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const pairCloud = async (
    code: string,
    machineName: string,
  ): Promise<CloudStatus | undefined> => {
    const outcome = await execute(
      "cloud:pair",
      runtime.client.PairCloud({ code, machineName }),
    );
    if (!outcome.ok) return undefined;
    setCloud(outcome.value);
    return outcome.value;
  };

  const unpairCloud = async (): Promise<CloudStatus | undefined> => {
    const outcome = await execute("cloud:unpair", runtime.client.UnpairCloud());
    if (!outcome.ok) return undefined;
    setCloud(outcome.value);
    setCloudAccounts([]);
    return outcome.value;
  };

  const reportShellPermission = async (
    permission: "accessibility",
    status: PermissionStatus,
  ): Promise<boolean> => {
    const outcome = await execute(
      `shell:permission:${permission}`,
      runtime.client.ReportShellPermission({ permission, status }),
    );
    return outcome.ok;
  };

  const shutdownService = async (force?: boolean): Promise<boolean> => {
    const outcome = await execute(
      "service:shutdown",
      runtime.client.ShutdownService({
        ...(force === undefined ? {} : { force }),
      }),
    );
    return outcome.ok;
  };

  const isPending = (key: string): boolean => pending().includes(key);
  const isProjectLoading = (projectId: string): boolean =>
    projectLoading().includes(projectId);
  const clearActionError = (): void => setLastActionError(undefined);

  return {
    transport: runtime.transport,
    snapshot,
    info: () => snapshot()?.info,
    health: () => snapshot()?.health,
    watchStatus,
    logStatus,
    lastActionError,
    logs,
    pending,
    setLogProject,
    receiveLog: appendLog,
    projects,
    project,
    projectDetail,
    projectErrorMessage,
    projectConsent,
    projectRevision,
    projectFileRevision,
    integrations,
    loadIntegrations,
    artifacts,
    artifactRevision,
    artifactListRevision,
    artifactUrlRevision,
    fetchArtifacts,
    getArtifactView,
    renewArtifactView,
    createArtifactUrl,
    listArtifactUrls,
    revokeArtifactUrl,
    listArtifactUrlConfirmations,
    approveArtifactUrl,
    rejectArtifactUrl,
    cloudAccounts,
    loadCloudAccounts,
    connections,
    connection,
    cloud,
    start,
    whenReady,
    dispose,
    isPending,
    isProjectLoading,
    clearActionError,
    refresh,
    refreshProjectConsents,
    fetchProject,
    createProject,
    addProject,
    removeProject,
    startProject,
    stopProject,
    restartProject,
    setProjectParam,
    approveProjectConsent,
    rejectProjectConsent,
    listProjectFiles,
    readProjectFile,
    listTimers,
    cancelTimer,
    setProjectBinding,
    createConnection,
    updateConnection,
    deleteConnection,
    configureConnection,
    connectConnection,
    disconnectConnection,
    startConnectionAuth,
    beginCloudPairing,
    pairCloud,
    unpairCloud,
    reportShellPermission,
    shutdownService,
  };
};
