import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcClient } from "effect/rpc";

import { CloudPairingSession, CloudStatus } from "./cloud.ts";
import {
  ConfigureConnectionRequest,
  ConnectionAuth,
  ConnectionIdRequest,
  ConnectionSummary,
  ListConnectionsResponse,
  StartConnectionAuthRequest,
} from "./connections.ts";
import { AgentError } from "./common.ts";
import { ServiceEvent, WatchServiceRequest } from "./events.ts";
import {
  EventRecord,
  LogEntry,
  StreamEventsRequest,
  StreamLogsRequest,
} from "./logs.ts";
import {
  AddProjectRequest,
  ListProjectsResponse,
  ProjectDetail,
  ProjectIdRequest,
  RemoveProjectRequest,
} from "./projects.ts";
import {
  RejectConsentRequest,
  ScriptIdRequest,
  SetScriptEnabledRequest,
  SetScriptParamRequest,
} from "./requests.ts";
import { ConsentRequest, ScriptDetail, ScriptSource, ScriptSummary } from "./scripts.ts";
import { HealthStatus, ServiceInfo } from "./service.ts";

export const AGENT_RPC_PATH = "/rpc" as const;

/**
 * Service lifecycle and discovery. `GetServiceInfo` is what a shell calls
 * after reading `service.json` to check the API version before adopting a
 * running service.
 */
export const GetServiceInfo = Rpc.make("GetServiceInfo", {
  success: ServiceInfo,
  error: AgentError,
});

export const GetHealth = Rpc.make("GetHealth", {
  success: HealthStatus,
  error: AgentError,
});

/**
 * Ask the service to exit. In installed mode the launch agent / supervisor
 * will not restart it unless the request says `restart: true`. The service
 * stops workers, connections and the cloud socket first; `force` skips that.
 */
export const ShutdownService = Rpc.make("ShutdownService", {
  payload: Schema.Struct({
    force: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Void,
  error: AgentError,
});

/**
 * Ask the service to exit with the supervisor's restart code so launchd / the
 * Run key / the shell starts a fresh generation. Used by the shell after an
 * update and by the CLI's `service restart`.
 */
export const RestartService = Rpc.make("RestartService", {
  payload: Schema.Struct({
    reason: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Void,
  error: AgentError,
});

/**
 * Projects. Projects are folders of scripts; connections and cloud pairing are
 * service-wide (see decision 0003 §2). `ListScripts`/streams take an optional
 * project filter so the UI can show one project or everything.
 */
export const ListProjects = Rpc.make("ListProjects", {
  success: ListProjectsResponse,
  error: AgentError,
});

export const GetProject = Rpc.make("GetProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Add an existing folder; the service plans its scripts but never starts them. */
export const AddProject = Rpc.make("AddProject", {
  payload: AddProjectRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Remove a project from the service; files on disk are left alone. */
export const RemoveProject = Rpc.make("RemoveProject", {
  payload: RemoveProjectRequest,
  success: Schema.Void,
  error: AgentError,
});

/**
 * Scripts. A script is identified by `(projectId, scriptId)`; mutations return
 * the new detail so the UI does not have to re-read the script.
 */
export const ListScripts = Rpc.make("ListScripts", {
  payload: Schema.Struct({
    projectId: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    scripts: Schema.Array(ScriptSummary),
  }),
  error: AgentError,
});

export const GetScript = Rpc.make("GetScript", {
  payload: ScriptIdRequest,
  success: ScriptDetail,
  error: AgentError,
});

/**
 * Read the script's entry file for the read-only source viewer. Editing is out
 * of scope in v1; this never writes.
 */
export const GetScriptSource = Rpc.make("GetScriptSource", {
  payload: ScriptIdRequest,
  success: ScriptSource,
  error: AgentError,
});

/** Re-plan the script and return the manifest/diff, without starting it. */
export const PlanScript = Rpc.make("PlanScript", {
  payload: ScriptIdRequest,
  success: ScriptDetail,
  error: AgentError,
});

/**
 * Start a script and mark it enabled, so it resumes after a service restart.
 * A new script has `enabled: false` until this (or `SetScriptEnabled`) is
 * called; consent is still required first when the plan adds permissions.
 */
export const StartScript = Rpc.make("StartScript", {
  payload: ScriptIdRequest,
  success: ScriptDetail,
  error: AgentError,
});

/** Stop a script and mark it disabled, so it does not resume. */
export const StopScript = Rpc.make("StopScript", {
  payload: ScriptIdRequest,
  success: ScriptDetail,
  error: AgentError,
});

export const RestartScript = Rpc.make("RestartScript", {
  payload: ScriptIdRequest,
  success: ScriptDetail,
  error: AgentError,
});

export const SetScriptParam = Rpc.make("SetScriptParam", {
  payload: SetScriptParamRequest,
  success: ScriptDetail,
  error: AgentError,
});

/**
 * Change whether a script resumes when the service starts. Enabling starts it
 * after consent; disabling stops it. This is separate from Start/Stop only so
 * the UI can express "start at login" without an immediate side effect.
 */
export const SetScriptEnabled = Rpc.make("SetScriptEnabled", {
  payload: SetScriptEnabledRequest,
  success: ScriptDetail,
  error: AgentError,
});

/** Consent is per script and per plan, not global. */
export const ListConsents = Rpc.make("ListConsents", {
  payload: Schema.Struct({
    projectId: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    consents: Schema.Array(ConsentRequest),
  }),
  error: AgentError,
});

export const ApproveConsent = Rpc.make("ApproveConsent", {
  payload: Schema.Struct({ consentId: Schema.String }),
  success: ScriptDetail,
  error: AgentError,
});

export const RejectConsent = Rpc.make("RejectConsent", {
  payload: RejectConsentRequest,
  success: ScriptDetail,
  error: AgentError,
});

/**
 * Connections. Connections are service-wide, not per project: one OBS socket
 * and one Twitch authorization are shared by every project that binds the same
 * slot. `usedBy` reports the scripts across projects. `ConfigureConnection`
 * accepts secrets, but `ConnectionSummary` never returns them.
 */
export const ListConnections = Rpc.make("ListConnections", {
  success: ListConnectionsResponse,
  error: AgentError,
});

export const GetConnection = Rpc.make("GetConnection", {
  payload: ConnectionIdRequest,
  success: ConnectionSummary,
  error: AgentError,
});

export const ConfigureConnection = Rpc.make("ConfigureConnection", {
  payload: ConfigureConnectionRequest,
  success: ConnectionSummary,
  error: AgentError,
});

export const ConnectConnection = Rpc.make("ConnectConnection", {
  payload: ConnectionIdRequest,
  success: ConnectionSummary,
  error: AgentError,
});

export const DisconnectConnection = Rpc.make("DisconnectConnection", {
  payload: ConnectionIdRequest,
  success: ConnectionSummary,
  error: AgentError,
});

/**
 * Start a browser/device-code OAuth flow. The returned URL/code is shown by
 * the UI; the connection becomes `connected` through the normal event stream
 * when the flow completes.
 */
export const StartConnectionAuth = Rpc.make("StartConnectionAuth", {
  payload: StartConnectionAuthRequest,
  success: ConnectionAuth,
  error: AgentError,
});

export const GetCloudStatus = Rpc.make("GetCloudStatus", {
  success: CloudStatus,
  error: AgentError,
});

/** Ask the cloud for a pairing code/URL to show the user. */
export const BeginCloudPairing = Rpc.make("BeginCloudPairing", {
  payload: Schema.Struct({ machineName: Schema.String }),
  success: CloudPairingSession,
  error: AgentError,
});

/** Claim a pairing code after the user finishes signing in. */
export const PairCloud = Rpc.make("PairCloud", {
  payload: Schema.Struct({ code: Schema.String, machineName: Schema.String }),
  success: CloudStatus,
  error: AgentError,
});

export const UnpairCloud = Rpc.make("UnpairCloud", {
  success: CloudStatus,
  error: AgentError,
});

/**
 * Streaming APIs. Each stream begins with buffered history (after `afterSeq`
 * when given) and then follows live output. A client can use `asQueue: true`
 * on the RPC client to get a scoped queue instead of a Stream.
 */
export const StreamLogs = Rpc.make("StreamLogs", {
  payload: StreamLogsRequest,
  success: LogEntry,
  error: AgentError,
  stream: true,
});

export const StreamEvents = Rpc.make("StreamEvents", {
  payload: StreamEventsRequest,
  success: EventRecord,
  error: AgentError,
  stream: true,
});

/** Snapshot first, then every state change until the client disconnects. */
export const WatchService = Rpc.make("WatchService", {
  payload: WatchServiceRequest,
  success: ServiceEvent,
  error: AgentError,
  stream: true,
});

export const AgentRpcs = RpcGroup.make(
  GetServiceInfo,
  GetHealth,
  ShutdownService,
  RestartService,
  ListProjects,
  GetProject,
  AddProject,
  RemoveProject,
  ListScripts,
  GetScript,
  GetScriptSource,
  PlanScript,
  StartScript,
  StopScript,
  RestartScript,
  SetScriptParam,
  SetScriptEnabled,
  ListConsents,
  ApproveConsent,
  RejectConsent,
  ListConnections,
  GetConnection,
  ConfigureConnection,
  ConnectConnection,
  DisconnectConnection,
  StartConnectionAuth,
  GetCloudStatus,
  BeginCloudPairing,
  PairCloud,
  UnpairCloud,
  StreamLogs,
  StreamEvents,
  WatchService,
);
export type AgentRpcs = typeof AgentRpcs;

/**
 * The generated client shape shared by the CLI, shell and UI transport. The
 * error parameter defaults to `never` for test/mock clients; a real WebSocket
 * client should use `AgentClient<RpcClientError>` so transport failures are
 * visible in the effect's error channel.
 */
export type AgentClient<E = never> = RpcClient.FromGroup<typeof AgentRpcs, E>;
