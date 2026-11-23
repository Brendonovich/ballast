import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "effect/socket";
import { AgentRpcs } from "@ballast/agent-protocol";
import type { AgentClient } from "@ballast/agent-protocol";
import type { PermissionStatus } from "../../bridge.ts";
import type { ServiceRegistration } from "./types.ts";

/**
 * The real service's shutdown and shell-permission calls are Effect RPCs
 * (`ShutdownService`, `ReportShellPermission`) over the authenticated
 * WebSocket at /rpc. The launcher falls back to SIGTERM/SIGKILL when a call
 * fails, so an older or wedged service cannot trap the UI (0003 §2).
 *
 * Only this module pulls Effect into the Electron main bundle; the launcher
 * stays plain TypeScript.
 */
type AgentRpcClient = AgentClient<RpcClientError>;

const withAgentClient = <A, E>(
  registration: ServiceRegistration,
  use: (client: AgentRpcClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  // Electron's main process has the Node global WebSocket, which cannot set
  // handshake headers. The service accepts the bearer token as ?token= for
  // /rpc only (the CLI still uses the Authorization header).
  const rpcUrl = new URL("/rpc", registration.url);
  rpcUrl.searchParams.set("token", registration.token);
  const socket = Socket.layerWebSocket(rpcUrl.toString()).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(protocol);
      const client = yield* RpcClient.make(AgentRpcs).pipe(Effect.provideContext(context));
      return yield* use(client);
    }),
  );
};

const runControl = async (
  registration: ServiceRegistration,
  use: Parameters<typeof withAgentClient>[1],
  timeoutMs: number,
): Promise<boolean> =>
  Effect.runPromise(
    withAgentClient(registration, use).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    ),
  );

/** Ask the running service to shut down gracefully. */
export async function requestServiceShutdown(
  registration: ServiceRegistration,
  timeoutMs = 3_000,
): Promise<boolean> {
  return runControl(registration, (client) => client.ShutdownService({ force: false }), timeoutMs);
}

/** Report a shell-owned permission (macOS Accessibility) to the service. */
export async function reportServicePermission(
  registration: ServiceRegistration,
  status: PermissionStatus,
  timeoutMs = 3_000,
): Promise<boolean> {
  return runControl(
    registration,
    (client) => client.ReportShellPermission({ permission: "accessibility", status }),
    timeoutMs,
  );
}
