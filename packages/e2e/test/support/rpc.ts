import { Effect, Layer } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Socket } from "effect/socket";
import { NodeSocket } from "@effect/platform-node";
import { AgentRpcs } from "@ballast/agent-protocol";
import type { AgentClient } from "@ballast/agent-protocol";
import type { ServiceRegistration } from "./process.ts";

export type LiveAgentClient = AgentClient<RpcClientError>;

export const withAgentClient = <A>(
  registration: ServiceRegistration,
  use: (client: LiveAgentClient) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const socket = Socket.layerWebSocket(
          registration.url.replace(/\/$/, "") + "/rpc",
          { headers: { authorization: "Bearer " + registration.token } },
        ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS));
        const protocol = RpcClient.layerProtocolSocket().pipe(
          Layer.provide(socket),
          Layer.provide(RpcSerialization.layerJson),
        );
        const context = yield* Layer.build(protocol);
        const client = yield* RpcClient.make(AgentRpcs).pipe(Effect.provideContext(context));
        return yield* use(client);
      }),
    ),
  );
