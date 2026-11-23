import type {
  CloudPairingSession,
  CloudStatus,
  ConnectionAuth,
  ConnectionMode,
  ConnectionSummary,
  ConsentRequest,
  HealthStatus,
  LogEntry,
  ParamValue,
  PermissionStatus,
  ProjectDetail,
  ProjectSummary,
  ScriptDetail,
  ScriptSource,
  ScriptSummary,
  ServiceEvent,
  ServiceInfo,
  ServiceSnapshot,
} from "@ballast/agent-protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";

import type { AgentRuntime, TransportConfig } from "../agent/client.ts";
import { runResilient } from "../agent/client.ts";
import { errorMessage } from "../agent/errors.ts";

export type ProjectSelection = string | "all";

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface CreateAgentStoreOptions {
  readonly initialProjectId?: ProjectSelection;
  readonly onError?: (message: string) => void;
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
  readonly details: Accessor<Readonly<Record<string, ScriptDetail>>>;
  readonly detailLoading: Accessor<ReadonlyArray<string>>;
  readonly detailErrors: Accessor<Readonly<Record<string, string>>>;
  readonly sourceRevisions: Accessor<Readonly<Record<string, number>>>;
  readonly selectedProjectId: Accessor<ProjectSelection | undefined>;
  readonly pending: Accessor<ReadonlyArray<string>>;
  readonly start: () => void;
  readonly whenReady: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly isPending: (key: string) => boolean;
  readonly isDetailLoading: (key: string) => boolean;
  readonly clearActionError: () => void;
  readonly selectProject: (projectId: ProjectSelection) => void;
  readonly currentProject: () => ProjectSummary | undefined;
  readonly projects: () => ReadonlyArray<ProjectSummary>;
  readonly project: (projectId: string) => ProjectSummary | undefined;
  readonly scripts: (projectId?: string) => ReadonlyArray<ScriptSummary>;
  readonly visibleScripts: () => ReadonlyArray<ScriptSummary>;
  readonly projectScriptCount: (projectId: string) => number;
  readonly runningScriptCount: (projectId?: string) => number;
  readonly script: (projectId: string, scriptId: string) => ScriptSummary | undefined;
  readonly detail: (projectId: string, scriptId: string) => ScriptDetail | undefined;
  readonly consents: () => ReadonlyArray<ConsentRequest>;
  readonly consent: (consentId: string) => ConsentRequest | undefined;
  readonly connections: () => ReadonlyArray<ConnectionSummary>;
  readonly connection: (connectionId: string) => ConnectionSummary | undefined;
  readonly cloud: () => CloudStatus | undefined;
  readonly refresh: () => Promise<boolean>;
  readonly fetchScript: (
    projectId: string,
    scriptId: string,
    force?: boolean,
  ) => Promise<ScriptDetail | undefined>;
  readonly fetchScriptSource: (
    projectId: string,
    scriptId: string,
  ) => Promise<ScriptSource | undefined>;
  readonly scriptSourceRevision: (projectId: string, scriptId: string) => number;
  readonly addProject: (
    path: string,
    name?: string,
  ) => Promise<ProjectDetail | undefined>;
  readonly removeProject: (projectId: string) => Promise<boolean>;
  readonly planScript: (projectId: string, scriptId: string) => Promise<ScriptDetail | undefined>;
  readonly startScript: (projectId: string, scriptId: string) => Promise<ScriptDetail | undefined>;
  readonly stopScript: (projectId: string, scriptId: string) => Promise<ScriptDetail | undefined>;
  readonly restartScript: (
    projectId: string,
    scriptId: string,
  ) => Promise<ScriptDetail | undefined>;
  readonly setScriptParam: (
    projectId: string,
    scriptId: string,
    key: string,
    value: ParamValue,
  ) => Promise<ScriptDetail | undefined>;
  readonly setScriptEnabled: (
    projectId: string,
    scriptId: string,
    enabled: boolean,
  ) => Promise<ScriptDetail | undefined>;
  readonly approveConsent: (consentId: string) => Promise<ScriptDetail | undefined>;
  readonly rejectConsent: (consentId: string) => Promise<ScriptDetail | undefined>;
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
  readonly restartService: (reason?: string) => Promise<boolean>;
  readonly shutdownService: (force?: boolean) => Promise<boolean>;
}

export const scriptKey = (projectId: string, scriptId: string): string =>
  `${projectId}\u0000${scriptId}`;

const selectionStorageKey = "ballast.project";
const selectedMissing = "all";

const readStoredSelection = (): ProjectSelection | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(selectionStorageKey);
    return value === null || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

const storeSelection = (value: ProjectSelection): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(selectionStorageKey, value);
  } catch {
    // Storage can be disabled; selection is still kept in memory.
  }
};

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

const withoutPendingConsent = (detail: ScriptDetail): ScriptDetail => {
  const { pendingConsent, ...rest } = detail;
  return pendingConsent === undefined ? detail : rest;
};

const byName = (a: ScriptSummary, b: ScriptSummary): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

/**
 * The single reactive source of truth for the UI. `WatchService` supplies the
 * snapshot and incremental events, `StreamLogs` fills the log buffer, and
 * mutations write their returned detail straight back so screens never race a
 * re-read.
 */
export const createAgentStore = (
  runtime: AgentRuntime,
  options: CreateAgentStoreOptions = {},
): AgentStore => {
  const [snapshot, setSnapshot] = createSignal<ServiceSnapshot>();
  const [watchStatus, setWatchStatus] = createSignal<StreamStatus>("connecting");
  const [logStatus, setLogStatus] = createSignal<StreamStatus>("connecting");
  const [lastActionError, setLastActionError] = createSignal<string>();
  const [logs, setLogs] = createSignal<ReadonlyArray<LogEntry>>([]);
  const [details, setDetails] = createSignal<Readonly<Record<string, ScriptDetail>>>({});
  const [detailLoading, setDetailLoading] = createSignal<ReadonlyArray<string>>([]);
  const [detailErrors, setDetailErrors] = createSignal<Readonly<Record<string, string>>>({});
  const [sourceRevisions, setSourceRevisions] = createSignal<
    Readonly<Record<string, number>>
  >({});
  const [selectedProjectId, setSelectedProjectId] = createSignal<ProjectSelection | undefined>(
    options.initialProjectId ?? readStoredSelection(),
  );
  const [pending, setPending] = createSignal<ReadonlyArray<string>>([]);

  const handles: Array<() => void> = [];
  const inFlight = new Map<string, Promise<ScriptDetail | undefined>>();
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
      on ? (current.includes(key) ? current : [...current, key]) : current.filter((entry) => entry !== key),
    );
  };

  const execute = async <A, E>(
    key: string,
    effect: Effect.Effect<A, E>,
    options?: { readonly ignoreError?: (message: string) => boolean },
  ): Promise<Outcome<A>> => {
    markPending(key, true);
    try {
      return { ok: true, value: await runtime.run(effect) };
    } catch (error) {
      const message = errorMessage(error);
      if (!options?.ignoreError?.(message)) notifyError(message);
      return { ok: false, message };
    } finally {
      markPending(key, false);
    }
  };

  const projects = (): ReadonlyArray<ProjectSummary> => snapshot()?.projects ?? [];
  const project = (projectId: string): ProjectSummary | undefined =>
    projects().find((entry) => entry.id === projectId);
  const scripts = (projectId?: string): ReadonlyArray<ScriptSummary> =>
    (snapshot()?.scripts ?? [])
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .slice()
      .sort(byName);
  const visibleScripts = (): ReadonlyArray<ScriptSummary> => {
    const selection = selectedProjectId();
    if (selection === undefined || selection === "all") {
      return scripts();
    }
    return scripts(selection);
  };
  const currentProject = (): ProjectSummary | undefined => {
    const selection = selectedProjectId();
    return typeof selection === "string" && selection !== "all"
      ? project(selection)
      : undefined;
  };
  const projectScriptCount = (projectId: string): number => scripts(projectId).length;
  const runningScriptCount = (projectId?: string): number =>
    scripts(projectId).filter((entry) => entry.status === "running").length;
  const script = (projectId: string, scriptId: string): ScriptSummary | undefined =>
    scripts(projectId).find((entry) => entry.id === scriptId);
  const detail = (projectId: string, scriptId: string): ScriptDetail | undefined =>
    details()[scriptKey(projectId, scriptId)];
  const consents = (): ReadonlyArray<ConsentRequest> => snapshot()?.consents ?? [];
  const consent = (consentId: string): ConsentRequest | undefined =>
    consents().find((entry) => entry.id === consentId);
  const connections = (): ReadonlyArray<ConnectionSummary> =>
    snapshot()?.connections ?? [];
  const connection = (connectionId: string): ConnectionSummary | undefined =>
    connections().find((entry) => entry.id === connectionId);
  const cloud = (): CloudStatus | undefined => snapshot()?.cloud;

  const syncSelection = (
    nextProjects: ReadonlyArray<ProjectSummary>,
    info: ServiceInfo | undefined,
  ): void => {
    const selection = selectedProjectId();
    if (selection === "all") return;
    if (selection !== undefined && nextProjects.some((entry) => entry.id === selection)) {
      return;
    }
    const stored = readStoredSelection();
    const storedProject =
      stored === undefined || stored === "all"
        ? undefined
        : nextProjects.find((entry) => entry.id === stored);
    const fallback =
      storedProject ??
      nextProjects.find((entry) => entry.id === info?.defaultProjectId) ??
      nextProjects[0];
    const next = fallback?.id ?? selectedMissing;
    setSelectedProjectId(next);
    storeSelection(next);
  };

  const upsertSummary = (summary: ScriptSummary): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        scripts: upsertBy(current.scripts, summary, (entry) => scriptKey(entry.projectId, entry.id)),
      };
    });
  };

  const upsertConsent = (entry: ConsentRequest): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        consents: upsertBy(current.consents, entry, (candidate) => candidate.id),
      };
    });
  };

  const removeConsent = (consentId: string): void => {
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        consents: removeBy(current.consents, (entry) => entry.id === consentId),
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

  const attachConsent = (entry: ConsentRequest): void => {
    const key = scriptKey(entry.projectId, entry.scriptId);
    setDetails((current) => {
      const existing = current[key];
      if (existing === undefined) return current;
      return { ...current, [key]: { ...existing, pendingConsent: entry } };
    });
  };

  const applyDetail = (next: ScriptDetail): void => {
    const key = scriptKey(next.summary.projectId, next.summary.id);
    setDetails((current) => ({ ...current, [key]: next }));
    upsertSummary(next.summary);
    if (next.pendingConsent === undefined) {
      removeConsent(
        consentForScript(next.summary.projectId, next.summary.id)?.id ?? "",
      );
    } else {
      upsertConsent(next.pendingConsent);
    }
  };

  const consentForScript = (
    projectId: string,
    scriptId: string,
  ): ConsentRequest | undefined =>
    consents().find((entry) => entry.projectId === projectId && entry.scriptId === scriptId);

  const applyScriptEvent = (summary: ScriptSummary): void => {
    upsertSummary(summary);
    const key = scriptKey(summary.projectId, summary.id);
    setDetails((current) => {
      const existing = current[key];
      if (existing === undefined) return current;
      const merged: ScriptDetail = { ...existing, summary };
      return {
        ...current,
        [key]:
          summary.status === "needs-consent"
            ? merged
            : withoutPendingConsent(merged),
      };
    });
  };

  const applyEvent = (event: ServiceEvent): void => {
    switch (event._tag) {
      case "snapshot": {
        setSnapshot(event.snapshot);
        setWatchStatus("live");
        syncSelection(event.snapshot.projects, event.snapshot.info);
        setDetails((current) => {
          const next: Record<string, ScriptDetail> = {};
          for (const [key, entry] of Object.entries(current)) {
            const summary = event.snapshot.scripts.find(
              (candidate) => scriptKey(candidate.projectId, candidate.id) === key,
            );
            if (summary === undefined) continue;
            const consent = event.snapshot.consents.find(
              (candidate) =>
                candidate.projectId === summary.projectId && candidate.scriptId === summary.id,
            );
            const merged: ScriptDetail = { ...entry, summary };
            next[key] =
              consent === undefined
                ? withoutPendingConsent(merged)
                : { ...withoutPendingConsent(merged), pendingConsent: consent };
          }
          return next;
        });
        readyResolve?.();
        readyResolve = undefined;
        return;
      }
      case "project": {
        const current = snapshot();
        if (current === undefined) return;
        const nextSnapshot: ServiceSnapshot = {
          ...current,
          projects: upsertBy(current.projects, event.project, (entry) => entry.id),
        };
        setSnapshot(nextSnapshot);
        syncSelection(nextSnapshot.projects, nextSnapshot.info);
        return;
      }
      case "project-removed": {
        const current = snapshot();
        if (current === undefined) return;
        const removedScripts = current.scripts.filter(
          (entry) => entry.projectId === event.projectId,
        );
        const nextSnapshot: ServiceSnapshot = {
          ...current,
          projects: removeBy(current.projects, (entry) => entry.id === event.projectId),
          scripts: removeBy(current.scripts, (entry) => entry.projectId === event.projectId),
          consents: removeBy(current.consents, (entry) => entry.projectId === event.projectId),
        };
        setSnapshot(nextSnapshot);
        setDetails((currentDetails) => {
          const next = { ...currentDetails };
          for (const removed of removedScripts) {
            delete next[scriptKey(removed.projectId, removed.id)];
          }
          return next;
        });
        syncSelection(nextSnapshot.projects, nextSnapshot.info);
        return;
      }
      case "script": {
        applyScriptEvent(event.script);
        return;
      }
      case "script-source-changed": {
        const key = scriptKey(event.projectId, event.scriptId);
        setSourceRevisions((current) => ({
          ...current,
          [key]: (current[key] ?? 0) + 1,
        }));
        return;
      }
      case "script-removed": {
        const key = scriptKey(event.projectId, event.scriptId);
        setSnapshot((current) => {
          if (current === undefined) return current;
          return {
            ...current,
            scripts: removeBy(
              current.scripts,
              (entry) => entry.projectId === event.projectId && entry.id === event.scriptId,
            ),
            consents: removeBy(
              current.consents,
              (entry) => entry.projectId === event.projectId && entry.scriptId === event.scriptId,
            ),
          };
        });
        setDetails((current) => {
          if (current[key] === undefined) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
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
      case "consent": {
        upsertConsent(event.consent);
        attachConsent(event.consent);
        return;
      }
      case "consent-resolved": {
        removeConsent(event.consentId);
        applyScriptEvent(event.script);
        const key = scriptKey(event.projectId, event.scriptId);
        setDetails((current) => {
          const existing = current[key];
          if (existing === undefined) return current;
          return { ...current, [key]: withoutPendingConsent({ ...existing, summary: event.script }) };
        });
        return;
      }
      case "health": {
        setSnapshot((current) =>
          current === undefined ? current : { ...current, health: event.health },
        );
        return;
      }
    }
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

    handles.push(
      runtime.start(
        runResilient(
          Effect.gen(function* () {
            while (snapshot() === undefined) {
              yield* Effect.sleep("50 millis");
            }
            const request = lastLogSeq === 0 ? {} : { afterSeq: lastLogSeq };
            yield* runtime.client.StreamLogs(request).pipe(
              Stream.onStart(Effect.sync(() => setLogStatus("live"))),
              Stream.runForEach((entry) =>
                Effect.sync(() => {
                  if (entry.seq <= lastLogSeq) return;
                  lastLogSeq = entry.seq;
                  setLogStatus("live");
                  setLogs((current) => {
                    const next = [...current, entry];
                    return next.length > 2_000 ? next.slice(next.length - 2_000) : next;
                  });
                }),
              ),
            );
          }),
          () => {
            setLogStatus("reconnecting");
          },
        ),
      ),
    );

  };

  const whenReady = (): Promise<void> => ready;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const interrupt of handles.splice(0)) interrupt();
    await runtime.dispose();
  };

  const selectProject = (projectId: ProjectSelection): void => {
    setSelectedProjectId(projectId);
    storeSelection(projectId);
  };

  const refresh = async (): Promise<boolean> => {
    const outcome = await execute(
      "service:refresh",
      Effect.gen(function* () {
        const info = yield* runtime.client.GetServiceInfo();
        const health = yield* runtime.client.GetHealth();
        const projectList = yield* runtime.client.ListProjects();
        const scriptList = yield* runtime.client.ListScripts({});
        const connectionList = yield* runtime.client.ListConnections();
        const cloudStatus = yield* runtime.client.GetCloudStatus();
        const consentList = yield* runtime.client.ListConsents({});
        return { info, health, projectList, scriptList, connectionList, cloudStatus, consentList };
      }),
    );
    if (!outcome.ok) return false;
    const next: ServiceSnapshot = {
      info: outcome.value.info,
      health: outcome.value.health,
      projects: outcome.value.projectList.projects,
      scripts: outcome.value.scriptList.scripts,
      connections: outcome.value.connectionList.connections,
      cloud: outcome.value.cloudStatus,
      consents: outcome.value.consentList.consents,
    };
    setSnapshot(next);
    setWatchStatus("live");
    syncSelection(next.projects, next.info);
    return true;
  };

  const fetchScript = async (
    projectId: string,
    scriptId: string,
    force = false,
  ): Promise<ScriptDetail | undefined> => {
    const key = scriptKey(projectId, scriptId);
    if (!force) {
      const cached = details()[key];
      if (cached !== undefined) return cached;
    }
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const promise = (async (): Promise<ScriptDetail | undefined> => {
      setDetailLoading((current) =>
        current.includes(key) ? current : [...current, key],
      );
      const outcome = await execute(
        `script:${key}:load`,
        runtime.client.GetScript({ projectId, scriptId }),
      );
      setDetailLoading((current) => current.filter((entry) => entry !== key));
      if (!outcome.ok) {
        setDetailErrors((current) => ({ ...current, [key]: outcome.message }));
        return undefined;
      }
      setDetailErrors((current) => {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      applyDetail(outcome.value);
      return outcome.value;
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  };

  const fetchScriptSource = async (
    projectId: string,
    scriptId: string,
  ): Promise<ScriptSource | undefined> => {
    const outcome = await execute(
      `script:${scriptKey(projectId, scriptId)}:source`,
      runtime.client.GetScriptSource({ projectId, scriptId }),
    );
    return outcome.ok ? outcome.value : undefined;
  };

  const scriptSourceRevision = (projectId: string, scriptId: string): number =>
    sourceRevisions()[scriptKey(projectId, scriptId)] ?? 0;

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
    setSnapshot((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        projects: upsertBy(current.projects, outcome.value.summary, (entry) => entry.id),
      };
    });
    const current = snapshot();
    if (current !== undefined) syncSelection(current.projects, current.info);
    return outcome.value;
  };

  const removeProject = async (projectId: string): Promise<boolean> => {
    const outcome = await execute(
      "project:remove",
      runtime.client.RemoveProject({ projectId }),
    );
    if (!outcome.ok) return false;
    const current = snapshot();
    if (current !== undefined) {
      const nextSnapshot: ServiceSnapshot = {
        ...current,
        projects: removeBy(current.projects, (entry) => entry.id === projectId),
        scripts: removeBy(current.scripts, (entry) => entry.projectId === projectId),
        consents: removeBy(current.consents, (entry) => entry.projectId === projectId),
      };
      setSnapshot(nextSnapshot);
      syncSelection(nextSnapshot.projects, nextSnapshot.info);
    }
    setDetails((currentDetails) => {
      const next = { ...currentDetails };
      for (const [key, entry] of Object.entries(currentDetails)) {
        if (entry.summary.projectId === projectId) delete next[key];
      }
      return next;
    });
    return true;
  };

  const runScriptAction = async (
    key: string,
    effect: Effect.Effect<ScriptDetail, unknown>,
    options?: { readonly ignoreError?: (message: string) => boolean },
  ): Promise<ScriptDetail | undefined> => {
    const outcome = await execute(key, effect, options);
    if (!outcome.ok) return undefined;
    applyDetail(outcome.value);
    return outcome.value;
  };

  const planScript = (
    projectId: string,
    scriptId: string,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:plan`,
      runtime.client.PlanScript({ projectId, scriptId }),
    );

  const startScript = (
    projectId: string,
    scriptId: string,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:start`,
      runtime.client.StartScript({ projectId, scriptId }),
      { ignoreError: (message) => message.includes("needs consent before it can start") },
    );

  const stopScript = (
    projectId: string,
    scriptId: string,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:stop`,
      runtime.client.StopScript({ projectId, scriptId }),
    );

  const restartScript = (
    projectId: string,
    scriptId: string,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:restart`,
      runtime.client.RestartScript({ projectId, scriptId }),
      { ignoreError: (message) => message.includes("needs consent before it can start") },
    );

  const setScriptParam = (
    projectId: string,
    scriptId: string,
    key: string,
    value: ParamValue,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:param:${key}`,
      runtime.client.SetScriptParam({ projectId, scriptId, key, value }),
    );

  const setScriptEnabled = (
    projectId: string,
    scriptId: string,
    enabled: boolean,
  ): Promise<ScriptDetail | undefined> =>
    runScriptAction(
      `script:${scriptKey(projectId, scriptId)}:enabled`,
      runtime.client.SetScriptEnabled({ projectId, scriptId, enabled }),
    );

  const approveConsent = async (
    consentId: string,
  ): Promise<ScriptDetail | undefined> => {
    const outcome = await execute(
      `consent:${consentId}:approve`,
      runtime.client.ApproveConsent({ consentId }),
    );
    if (!outcome.ok) return undefined;
    applyDetail(outcome.value);
    return outcome.value;
  };

  const rejectConsent = async (
    consentId: string,
  ): Promise<ScriptDetail | undefined> => {
    const outcome = await execute(
      `consent:${consentId}:reject`,
      runtime.client.RejectConsent({ consentId }),
    );
    if (!outcome.ok) return undefined;
    applyDetail(outcome.value);
    return outcome.value;
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

  const restartService = async (reason?: string): Promise<boolean> => {
    const outcome = await execute(
      "service:restart",
      runtime.client.RestartService({
        ...(reason === undefined ? {} : { reason }),
      }),
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
  const isDetailLoading = (key: string): boolean => detailLoading().includes(key);
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
    details,
    detailLoading,
    detailErrors,
    sourceRevisions,
    selectedProjectId,
    pending,
    start,
    whenReady,
    dispose,
    isPending,
    isDetailLoading,
    clearActionError,
    selectProject,
    currentProject,
    projects,
    project,
    scripts,
    visibleScripts,
    projectScriptCount,
    runningScriptCount,
    script,
    detail,
    consents,
    consent,
    connections,
    connection,
    cloud,
    refresh,
    fetchScript,
    fetchScriptSource,
    scriptSourceRevision,
    addProject,
    removeProject,
    planScript,
    startScript,
    stopScript,
    restartScript,
    setScriptParam,
    setScriptEnabled,
    approveConsent,
    rejectConsent,
    configureConnection,
    connectConnection,
    disconnectConnection,
    startConnectionAuth,
    beginCloudPairing,
    pairCloud,
    unpairCloud,
    reportShellPermission,
    restartService,
    shutdownService,
  };
};
