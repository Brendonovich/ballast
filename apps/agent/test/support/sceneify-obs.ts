import { MockOBSSocket } from "@sceneify/core-rewrite";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { startMockObsServer, type MockObsServer } from "../mock-obs-server.ts";

export interface SceneifyObs {
  readonly obs: ReturnType<typeof MockOBSSocket.make>;
  readonly server: MockObsServer;
}

/** Sceneify's in-memory OBS behind the agent's obs-websocket mock server. */
export const startSceneifyObs: Effect.Effect<SceneifyObs, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(async () => {
    const obs = MockOBSSocket.make();
    const server = await startMockObsServer({
      backend: (requestType, requestData) =>
        Effect.runPromise(
          obs.service.call(requestType as never, requestData as never).pipe(
            Effect.mapError((error) => {
              const cause = error.cause as { code?: number; message?: string } | undefined;
              return { code: cause?.code ?? 500, message: cause?.message ?? error.message };
            }),
          ) as Effect.Effect<unknown, unknown>,
        ),
    });
    return { obs, server };
  }),
  ({ server }) => Effect.promise(() => server.close()),
);
