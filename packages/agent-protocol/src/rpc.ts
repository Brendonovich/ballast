import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcClient } from "effect/rpc";

import { CloudPairingSession, CloudStatus } from "./cloud.ts";
import {
  ConfigureConnectionRequest,
  ConnectionAuth,
  ConnectionIdRequest,
  ConnectionSummary,
  CreateConnectionRequest,
  DeleteConnectionRequest,
  ListConnectionsResponse,
  ListIntegrationsResponse,
  StartConnectionAuthRequest,
  UpdateConnectionRequest,
} from "./connections.ts";
import { AgentError, PermissionStatus } from "./common.ts";
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
  CreateProjectRequest,
  ListProjectFilesRequest,
  ListProjectFilesResponse,
  ProjectCheckResult,
  ProjectConsentRequest,
  ProjectFileContent,
  ReadProjectFileRequest,
  SetProjectBindingRequest,
  SetProjectEnabledRequest,
  SetProjectParamRequest,
} from "./project.ts";
import {
  RejectConsentRequest,
  ScriptIdRequest,
  SetScriptEnabledRequest,
  SetScriptParamRequest,
} from "./requests.ts";
import { ConsentRequest, ScriptDetail, ScriptSource, ScriptSummary } from "./scripts.ts";
import { HealthStatus, ServiceInfo } from "./service.ts";
import {
  CancelTimerRequest,
  CancelTimerResponse,
  ListTimersRequest,
  ListTimersResponse,
} from "./timers.ts";

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
 * Ask the service to exit 0. Nothing respawns it; a restart is the caller
 * (desktop app or CLI) stopping it and starting a new process. The service
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
 * Report a permission only the desktop shell can query. The service applies it
 * to running keyboard connections and exposes it in `GetHealth.permissions`.
 * `accessibility` maps to `systemPreferences.isTrustedAccessibilityClient` on
 * macOS; other platforms report `granted`.
 */
export const ReportShellPermission = Rpc.make("ReportShellPermission", {
  payload: Schema.Struct({
    permission: Schema.Literals(["accessibility"]),
    status: PermissionStatus,
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

/** Project bundle lifecycle. One project = one entry + one worker. */
export const CreateProject = Rpc.make("CreateProject", {
  payload: CreateProjectRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Typecheck + bundle + plan + diff, without applying or starting. */
export const CheckProject = Rpc.make("CheckProject", {
  payload: ProjectIdRequest,
  success: ProjectCheckResult,
  error: AgentError,
});

export const PlanProject = Rpc.make("PlanProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

export const StartProject = Rpc.make("StartProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

export const StopProject = Rpc.make("StopProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

export const RestartProject = Rpc.make("RestartProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

export const SetProjectParam = Rpc.make("SetProjectParam", {
  payload: SetProjectParamRequest,
  success: ProjectDetail,
  error: AgentError,
});

export const SetProjectEnabled = Rpc.make("SetProjectEnabled", {
  payload: SetProjectEnabledRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Bind or unbind a project requirement to a service-level connection instance. */
export const SetProjectBinding = Rpc.make("SetProjectBinding", {
  payload: SetProjectBindingRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Read-only project file tree and files (no write/upload RPC). */
export const ListProjectFiles = Rpc.make("ListProjectFiles", {
  payload: ListProjectFilesRequest,
  success: ListProjectFilesResponse,
  error: AgentError,
});

export const ReadProjectFile = Rpc.make("ReadProjectFile", {
  payload: ReadProjectFileRequest,
  success: ProjectFileContent,
  error: AgentError,
});

/** The entry file, replacing GetScriptSource. */
export const GetProjectSource = Rpc.make("GetProjectSource", {
  payload: ProjectIdRequest,
  success: ProjectFileContent,
  error: AgentError,
});

export const ListProjectConsents = Rpc.make("ListProjectConsents", {
  payload: Schema.Struct({ projectId: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ consents: Schema.Array(ProjectConsentRequest) }),
  error: AgentError,
});

export const ApproveProjectConsent = Rpc.make("ApproveProjectConsent", {
  payload: Schema.Struct({ consentId: Schema.String }),
  success: ProjectDetail,
  error: AgentError,
});

export const RejectProjectConsent = Rpc.make("RejectProjectConsent", {
  payload: Schema.Struct({
    consentId: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  }),
  success: ProjectDetail,
  error: AgentError,
});

/** Consent is per script and per plan, not global. */
/** Durable timer instances; declarations live in `ScriptManifest.timers`. */
export const ListTimers = Rpc.make("ListTimers", {
  payload: ListTimersRequest,
  success: ListTimersResponse,
  error: AgentError,
});

/** Cancel one persisted timer instance. Missing keys are not an error. */
export const CancelTimer = Rpc.make("CancelTimer", {
  payload: CancelTimerRequest,
  success: CancelTimerResponse,
  error: AgentError,
});

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
 * Connection instances. Instances exist at the service level and are created
 * without a project. Projects bind their manifest slots to instances with
 * `SetProjectBinding`; `boundBy` reports the project slots using an instance.
 */
export const ListIntegrations = Rpc.make("ListIntegrations", {
  success: ListIntegrationsResponse,
  error: AgentError,
});

export const ListConnections = Rpc.make("ListConnections", {
  success: ListConnectionsResponse,
  error: AgentError,
});

export const CreateConnection = Rpc.make("CreateConnection", {
  payload: CreateConnectionRequest,
  success: ConnectionSummary,
  error: AgentError,
});

export const UpdateConnection = Rpc.make("UpdateConnection", {
  payload: UpdateConnectionRequest,
  success: ConnectionSummary,
  error: AgentError,
});

/** Refuses to delete an instance while any project slot is bound to it. */
export const DeleteConnection = Rpc.make("DeleteConnection", {
  payload: DeleteConnectionRequest,
  success: Schema.Void,
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
  ReportShellPermission,
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
  CreateProject,
  CheckProject,
  PlanProject,
  StartProject,
  StopProject,
  RestartProject,
  SetProjectParam,
  SetProjectEnabled,
  SetProjectBinding,
  ListProjectFiles,
  ReadProjectFile,
  GetProjectSource,
  ListProjectConsents,
  ApproveProjectConsent,
  RejectProjectConsent,
  ListTimers,
  CancelTimer,
  ListConsents,
  ApproveConsent,
  RejectConsent,
  ListIntegrations,
  ListConnections,
  CreateConnection,
  UpdateConnection,
  DeleteConnection,
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
