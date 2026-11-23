import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "effect/socket";
import * as Stream from "effect/Stream";
import { NodeSocket } from "@effect/platform-node";
import { AgentRpcs } from "@ballast/agent-protocol";
import type {
  AgentClient,
  ConnectionSummary,
  EventRecord,
  HealthStatus,
  ArtifactSummary,
  ListProjectFilesResponse,
  LogEntry,
  ListEventHistorySubscriptionsRequest,
  ListEventHistorySubscriptionsResponse,
  ProjectCheckResult,
  ProjectDetail,
  ProjectSummary,
  QueryEventHistoryRequest,
  QueryEventHistoryResponse,
  StreamEventsRequest,
  StreamLogsRequest,
} from "@ballast/agent-protocol";

import type { McpConfig } from "./config.ts";
import { discoverService, DiscoveryError } from "./discovery.ts";
import {
  formatUnknown,
  missingFeatureOf,
  ToolError,
  toolError,
  unsupportedServiceError,
} from "./errors.ts";

export type LiveAgentClient = AgentClient<RpcClientError>;

export interface GatewayOptions {
  readonly config: McpConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

const websocketUrl = (url: string): string => url.replace(/\/$/, "") + "/rpc";

/** One WebSocket RPC client per call; local calls are cheap and this avoids stale clients. */
export const withAgentClient = <A, E>(
  options: GatewayOptions,
  use: (client: LiveAgentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, ToolError> =>
  Effect.gen(function* () {
    const connection = yield* discoverService({
      config: options.config,
      env: options.env,
      platform: options.platform,
      home: options.home,
    }).pipe(
      Effect.catchTag("DiscoveryError", (error: DiscoveryError) =>
        Effect.fail(toolError(error.message)),
      ),
    );

    const socket = Socket.layerWebSocket(websocketUrl(connection.url), {
      headers: { authorization: "Bearer " + connection.token },
    }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS));
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerJson),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const protocolContext = yield* Layer.build(protocol);
        const client = yield* RpcClient.make(AgentRpcs).pipe(
          Effect.provideContext(protocolContext),
        );
        return yield* use(client).pipe(
          // A service from before an RPC existed answers with a defect such as
          // "Unknown request tag: ListArtifacts". Probe the version on the
          // same live client and report the mismatch instead of a raw Cause.
          Effect.catchCause((cause) => {
            if (missingFeatureOf(cause) === undefined) return Effect.failCause(cause);
            return Effect.gen(function* () {
              const infoVersion = yield* client.GetServiceInfo().pipe(
                Effect.map((info) => info.version),
                Effect.timeoutOption("2 seconds"),
                Effect.map(Option.getOrUndefined),
                Effect.catchCause(() => Effect.succeed(undefined)),
              );
              const version = infoVersion ?? connection.registration?.version;
              const error = unsupportedServiceError(cause, version);
              return error === undefined
                ? yield* Effect.failCause(cause)
                : yield* Effect.fail(error);
            });
          }),
        );
      }),
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(cause instanceof ToolError ? cause : toolError(formatUnknown(cause))),
    ),
  );

/**
 * The service operations the project tools need. This is the seam the W4
 * project RPCs plug into; see packages/mcp/README.md for the final interface.
 */
export interface AgentGateway {
  readonly health: () => Effect.Effect<HealthStatus, ToolError>;
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ProjectSummary>, ToolError>;
  readonly getProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly createProject: (
    name: string,
    directory?: string,
    artifact?: boolean,
  ) => Effect.Effect<ProjectDetail, ToolError>;
  /** Non-applying typecheck + bundle + plan + diff. */
  readonly checkProject: (projectId: string) => Effect.Effect<ProjectCheckResult, ToolError>;
  readonly listProjectFiles: (
    projectId: string,
  ) => Effect.Effect<ListProjectFilesResponse, ToolError>;
  readonly listArtifacts: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactSummary>, ToolError>;
  readonly restartProject: (projectId: string) => Effect.Effect<ProjectDetail, ToolError>;
  readonly listConnections: () => Effect.Effect<ReadonlyArray<ConnectionSummary>, ToolError>;
  readonly queryEventHistory: (
    request: QueryEventHistoryRequest,
  ) => Effect.Effect<QueryEventHistoryResponse, ToolError>;
  readonly listEventHistorySubscriptions: (
    request: ListEventHistorySubscriptionsRequest,
  ) => Effect.Effect<ListEventHistorySubscriptionsResponse, ToolError>;
  readonly logs: (
    request: StreamLogsRequest,
    take: number,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, ToolError>;
  readonly events: (
    request: StreamEventsRequest,
    take: number,
  ) => Effect.Effect<ReadonlyArray<EventRecord>, ToolError>;
}

const snapshot = <A>(
  stream: Stream.Stream<A, unknown>,
  take: number,
): Effect.Effect<ReadonlyArray<A>, ToolError> =>
  Effect.gen(function* () {
    const collected = yield* Ref.make<ReadonlyArray<A>>([]);
    // The service's streams replay history and then follow live output. Take a
    // bounded prefix and stop waiting shortly after the replay, so a tool call
    // returns instead of hanging on an empty live stream.
    yield* stream.pipe(
      Stream.take(take),
      Stream.runForEach((entry) =>
        Ref.update(collected, (current) => [...current, entry]),
      ),
      Effect.timeoutOption("800 millis"),
      Effect.ignore,
    );
    return yield* Ref.get(collected);
  });

export const makeAgentGateway = (options: GatewayOptions): AgentGateway => ({
  health: () => withAgentClient(options, (client) => client.GetHealth()),
  listProjects: () =>
    withAgentClient(options, (client) => client.ListProjects()).pipe(
      Effect.map((response) => response.projects),
    ),
  getProject: (projectId) =>
    withAgentClient(options, (client) => client.GetProject({ projectId })),
  createProject: (name, directory, artifact) =>
    withAgentClient(options, (client) =>
      client.CreateProject({
        name,
        ...(directory === undefined ? {} : { directory }),
        ...(artifact === undefined ? {} : { artifact }),
      }),
    ),
  checkProject: (projectId) =>
    withAgentClient(options, (client) => client.CheckProject({ projectId })),
  listProjectFiles: (projectId) =>
    withAgentClient(options, (client) => client.ListProjectFiles({ projectId })),
  listArtifacts: (projectId) =>
    withAgentClient(options, (client) => client.ListArtifacts({ projectId })).pipe(
      Effect.map((response) => response.artifacts),
    ),
  restartProject: (projectId) =>
    withAgentClient(options, (client) => client.RestartProject({ projectId })),
  listConnections: () =>
    withAgentClient(options, (client) => client.ListConnections()).pipe(
      Effect.map((response) => response.connections),
    ),
  queryEventHistory: (request) =>
    withAgentClient(options, (client) => client.QueryEventHistory(request)),
  listEventHistorySubscriptions: (request) =>
    withAgentClient(options, (client) =>
      client.ListEventHistorySubscriptions(request),
    ),
  logs: (request, take) =>
    withAgentClient(options, (client) => snapshot(client.StreamLogs(request), take)),
  events: (request, take) =>
    withAgentClient(options, (client) => snapshot(client.StreamEvents(request), take)),
});
