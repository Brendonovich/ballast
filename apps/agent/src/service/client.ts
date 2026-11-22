import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "effect/socket";
import { NodeSocket } from "@effect/platform-node";
import { AgentRpcs } from "@ballast/agent-protocol";
import type { AgentClient } from "@ballast/agent-protocol";
import { readServiceRegistration, resolveDataDir, resolveStateDir } from "./config.ts";
import type { ServiceRegistration } from "./config.ts";

export interface ServiceConnection {
  readonly url: string;
  readonly token: string;
  readonly registration: ServiceRegistration | undefined;
}

export class ServiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailable";
  }
}

const isLoopback = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
};

export const discoverService = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ServiceConnection> => {
  const envUrl = env["BALLAST_SERVICE_URL"];
  const envToken = env["BALLAST_SERVICE_TOKEN"];
  if (envUrl !== undefined && envUrl !== "" && envToken !== undefined && envToken !== "") {
    if (!isLoopback(envUrl)) {
      throw new ServiceUnavailable("BALLAST_SERVICE_URL must point at a loopback address");
    }
    return { url: envUrl.replace(/\/$/, ""), token: envToken, registration: undefined };
  }

  const candidates = [resolveStateDir(env), resolveDataDir(env)];
  for (const stateDir of candidates) {
    const registration = await readServiceRegistration(stateDir);
    if (registration === undefined) continue;
    if (!isLoopback(registration.url)) continue;
    return {
      url: registration.url.replace(/\/$/, ""),
      token: registration.token,
      registration,
    };
  }
  throw new ServiceUnavailable(
    "No Ballast service found. Start one with `ballast serve` or set BALLAST_SERVICE_URL and BALLAST_SERVICE_TOKEN.",
  );
};

const websocketUrl = (url: string): string => `${url.replace(/\/$/, "")}/rpc`;

export type LiveAgentClient = AgentClient<RpcClientError>;

export const withAgentClient = <A, E>(
  use: (client: LiveAgentClient) => Effect.Effect<A, E>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<A, E | ServiceUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* Effect.tryPromise({
      try: () => discoverService(env),
      catch: (cause) =>
        cause instanceof ServiceUnavailable
          ? cause
          : new ServiceUnavailable(cause instanceof Error ? cause.message : String(cause)),
    });

    const socket = Socket.layerWebSocket(websocketUrl(connection.url), {
      headers: { authorization: `Bearer ${connection.token}` },
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
        return yield* use(client);
      }),
    );
  });
