import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcClient } from "effect/rpc";

import {
  CloudPairingSession,
  CloudStatus,
  ListCloudAccountsResponse,
} from "./cloud.ts";
import {
  ApplyProjectUpdateResult,
  DeployProjectResult,
  ShareProjectRequest,
  SubscribeProjectRequest,
} from "./shares.ts";
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
import {
  ApproveArtifactUrlRequest,
  ApproveArtifactUrlResponse,
  ArtifactView,
  CreateArtifactUrlRequest,
  CreateArtifactUrlResult,
  GetArtifactViewRequest,
  ListArtifactUrlConfirmationsRequest,
  ListArtifactUrlConfirmationsResponse,
  ListArtifactUrlsRequest,
  ListArtifactUrlsResponse,
  ListArtifactsRequest,
  ListArtifactsResponse,
  RejectArtifactUrlRequest,
  RenewArtifactViewRequest,
  RenewArtifactViewResponse,
  RevokeArtifactUrlRequest,
} from "./artifacts.ts";
import { AgentError, PermissionStatus } from "./common.ts";
import { ServiceEvent, WatchServiceRequest } from "./events.ts";
import {
  EventRecord,
  ListEventHistorySubscriptionsRequest,
  ListEventHistorySubscriptionsResponse,
  LogEntry,
  QueryEventHistoryRequest,
  QueryEventHistoryResponse,
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

/**
 * Share this project (creating the share on first use) and deploy
 * its current files. Fails for a subscribed project.
 */
export const ShareProject = Rpc.make("ShareProject", {
  payload: ShareProjectRequest,
  success: DeployProjectResult,
  error: AgentError,
});

/** Deploy a new version of an already-shared project. */
export const DeployProject = Rpc.make("DeployProject", {
  payload: ShareProjectRequest,
  success: DeployProjectResult,
  error: AgentError,
});

/** Download a share by share code into a new, stopped, read-only project. */
export const SubscribeProject = Rpc.make("SubscribeProject", {
  payload: SubscribeProjectRequest,
  success: ProjectDetail,
  error: AgentError,
});

/** Stop following the share; the files stay as an ordinary local project. */
export const UnsubscribeProject = Rpc.make("UnsubscribeProject", {
  payload: ProjectIdRequest,
  success: ProjectDetail,
  error: AgentError,
});

/**
 * Apply the available update: download the changed files, verify them, swap
 * them in, then restart a running project once. Overwrites local edits.
 */
export const ApplyProjectUpdate = Rpc.make("ApplyProjectUpdate", {
  payload: ProjectIdRequest,
  success: ApplyProjectUpdateResult,
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
 * the UI. Local flows complete through the normal event stream; after a cloud
 * browser flow, `ConnectConnection` refreshes and reconciles the account.
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

/** Twitch accounts available through this machine's linked Ballast cloud. */
export const ListCloudAccounts = Rpc.make("ListCloudAccounts", {
  success: ListCloudAccountsResponse,
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
/** Artifact declarations from the project manifest. */
export const ListArtifacts = Rpc.make("ListArtifacts", {
  payload: ListArtifactsRequest,
  success: ListArtifactsResponse,
  error: AgentError,
});

/** Mint a short-lived action-capable token for the app's own artifact iframe. */
export const GetArtifactView = Rpc.make("GetArtifactView", {
  payload: GetArtifactViewRequest,
  success: ArtifactView,
  error: AgentError,
});

/** Extend an open view token in place, keeping the page and sockets alive. */
export const RenewArtifactView = Rpc.make("RenewArtifactView", {
  payload: RenewArtifactViewRequest,
  success: RenewArtifactViewResponse,
  error: AgentError,
});

/** Create a persistent OBS URL; action scope returns a confirmation request. */
export const CreateArtifactUrl = Rpc.make("CreateArtifactUrl", {
  payload: CreateArtifactUrlRequest,
  success: CreateArtifactUrlResult,
  error: AgentError,
});

export const ListArtifactUrls = Rpc.make("ListArtifactUrls", {
  payload: ListArtifactUrlsRequest,
  success: ListArtifactUrlsResponse,
  error: AgentError,
});

export const RevokeArtifactUrl = Rpc.make("RevokeArtifactUrl", {
  payload: RevokeArtifactUrlRequest,
  success: Schema.Void,
  error: AgentError,
});

export const ListArtifactUrlConfirmations = Rpc.make(
  "ListArtifactUrlConfirmations",
  {
    payload: ListArtifactUrlConfirmationsRequest,
    success: ListArtifactUrlConfirmationsResponse,
    error: AgentError,
  },
);

export const ApproveArtifactUrl = Rpc.make("ApproveArtifactUrl", {
  payload: ApproveArtifactUrlRequest,
  success: ApproveArtifactUrlResponse,
  error: AgentError,
});

export const RejectArtifactUrl = Rpc.make("RejectArtifactUrl", {
  payload: RejectArtifactUrlRequest,
  success: Schema.Void,
  error: AgentError,
});

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

/** Durable subscription history, newest first. */
export const QueryEventHistory = Rpc.make("QueryEventHistory", {
  payload: QueryEventHistoryRequest,
  success: QueryEventHistoryResponse,
  error: AgentError,
});

/** Subscriptions declared by the project, optionally narrowed by name. */
export const ListEventHistorySubscriptions = Rpc.make(
  "ListEventHistorySubscriptions",
  {
    payload: ListEventHistorySubscriptionsRequest,
    success: ListEventHistorySubscriptionsResponse,
    error: AgentError,
  },
);

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
  ShareProject,
  DeployProject,
  SubscribeProject,
  UnsubscribeProject,
  ApplyProjectUpdate,
  ListTimers,
  CancelTimer,
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
  ListCloudAccounts,
  BeginCloudPairing,
  PairCloud,
  UnpairCloud,
  ListArtifacts,
  GetArtifactView,
  RenewArtifactView,
  CreateArtifactUrl,
  ListArtifactUrls,
  RevokeArtifactUrl,
  ListArtifactUrlConfirmations,
  ApproveArtifactUrl,
  RejectArtifactUrl,
  StreamLogs,
  StreamEvents,
  QueryEventHistory,
  ListEventHistorySubscriptions,
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
