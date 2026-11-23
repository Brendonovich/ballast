import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "effect/socket";
import { NodeSocket } from "@effect/platform-node";
import { AgentRpcs } from "@ballast/agent-protocol";
import type { AgentClient } from "@ballast/agent-protocol";
import {
  readEnvironment,
  readServiceRegistration,
  resolveServiceDirectories,
} from "./config.ts";
import type { Environment, ServiceRegistration } from "./config.ts";

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

const environmentKeys = [
  "BALLAST_SERVICE_URL",
  "BALLAST_SERVICE_TOKEN",
  "BALLAST_STATE_DIR",
  "BALLAST_DATA_DIR",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "HOME",
] as const;

export const discoverService = (
  env?: Environment,
): Effect.Effect<
  ServiceConnection,
  ServiceUnavailable,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const values = env ?? (yield* readEnvironment(environmentKeys));
    const envUrl = values["BALLAST_SERVICE_URL"];
    const envToken = values["BALLAST_SERVICE_TOKEN"];
    if (envUrl !== undefined && envUrl !== "" && envToken !== undefined && envToken !== "") {
      if (!isLoopback(envUrl)) {
        return yield* Effect.fail(
          new ServiceUnavailable("BALLAST_SERVICE_URL must point at a loopback address"),
        );
      }
      return { url: envUrl.replace(/\/$/, ""), token: envToken, registration: undefined };
    }

    const candidates = resolveServiceDirectories(path, values);
    for (const stateDir of candidates) {
      const registration = yield* readServiceRegistration(stateDir);
      if (registration === undefined) continue;
      if (!isLoopback(registration.url)) continue;
      return {
        url: registration.url.replace(/\/$/, ""),
        token: registration.token,
        registration,
      };
    }
    return yield* Effect.fail(
      new ServiceUnavailable(
        "No Ballast service found. Start one with `ballast service start` (or open the Ballast app), or set BALLAST_SERVICE_URL and BALLAST_SERVICE_TOKEN.",
      ),
    );
  });

const websocketUrl = (url: string): string => `${url.replace(/\/$/, "")}/rpc`;

export type LiveAgentClient = AgentClient<RpcClientError>;

export const withAgentClient = <A, E, R>(
  use: (client: LiveAgentClient) => Effect.Effect<A, E, R>,
  env?: Environment,
): Effect.Effect<
  A,
  E | ServiceUnavailable,
  FileSystem.FileSystem | Path.Path | R
> =>
  Effect.gen(function* () {
    const connection = yield* discoverService(env);

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
