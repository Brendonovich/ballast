import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { Socket } from "effect/socket";
import { startObsDriver } from "../src/obs-driver.ts";
import type { ObsEventPacket } from "../src/obs-protocol.ts";
import { connectObsSocket } from "../src/obs-protocol.ts";
import { startMockObsServer } from "./mock-obs-server.ts";

const withServer = <A, E>(
  options: { readonly password?: string },
  use: (
    server: Awaited<ReturnType<typeof startMockObsServer>>,
  ) => Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>,
): Effect.Effect<A, E | Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startMockObsServer(options),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
        (instance) => Effect.promise(() => instance.close()),
      );
      return yield* use(server);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer));

describe("obs-websocket protocol", () => {
  it.live(
    "identifies, correlates requests and pushes events",
    () =>
      withServer({}, (server) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connectObsSocket(server.url, undefined, 0x7ff).pipe(
              Effect.provide(Socket.layerWebSocketConstructorGlobal),
            );

            const scenes = yield* client.request("GetSceneList", {});
            expect(scenes).toMatchObject({
              currentProgramSceneName: "Scene 1",
              scenes: [
                { sceneName: "Scene 1", sceneIndex: 0 },
                { sceneName: "Scene 2", sceneIndex: 1 },
              ],
            });

            yield* Effect.sync(() => {
              server.emit("CurrentProgramSceneChanged", {
                sceneName: "Scene 2",
                sceneUuid: "uuid-Scene-2",
              });
            });

            const event: ObsEventPacket = yield* Queue.take(client.events).pipe(
              Effect.timeout("2 seconds"),
            );
            expect(event.eventType).toBe("CurrentProgramSceneChanged");
            expect(event.eventData).toEqual({
              sceneName: "Scene 2",
              sceneUuid: "uuid-Scene-2",
            });
          }),
        ),
      ),
    10_000,
  );

  it.live(
    "performs the SHA-256 authentication challenge",
    () =>
      withServer({ password: "hunter2" }, (server) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connectObsSocket(server.url, "hunter2", 0).pipe(
              Effect.provide(Socket.layerWebSocketConstructorGlobal),
            );
            const version = yield* client.request("GetVersion", {});
            expect(version).toMatchObject({ obsWebSocketVersion: "5.7.0" });
          }),
        ),
      ),
    10_000,
  );

  it.live(
    "fails when OBS requires a password that was not provided",
    () =>
      withServer({ password: "hunter2" }, (server) =>
        Effect.scoped(
          Effect.gen(function* () {
            const exit = yield* connectObsSocket(server.url, undefined, 0).pipe(
              Effect.provide(Socket.layerWebSocketConstructorGlobal),
              Effect.exit,
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Exit.findErrorOption(exit);
              expect(Option.isSome(error)).toBe(true);
              if (Option.isSome(error)) {
                expect(error.value.message).toContain("requires a password");
              }
            }
          }),
        ),
      ),
    10_000,
  );

  it.live(
    "rejects a wrong password",
    () =>
      withServer({ password: "hunter2" }, (server) =>
        Effect.scoped(
          Effect.gen(function* () {
            const exit = yield* connectObsSocket(server.url, "wrong", 0).pipe(
              Effect.provide(Socket.layerWebSocketConstructorGlobal),
              Effect.exit,
            );
            expect(Exit.isFailure(exit)).toBe(true);
          }),
        ),
      ),
    10_000,
  );
});

describe("obs driver", () => {
  it.live(
    "reconnects with backoff after the server restarts",
    () =>
      withServer({}, (server) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const driver = yield* startObsDriver({
            slot: "main",
            url: server.url,
            topics: [],
            publish: () => undefined,
          }).pipe(Scope.provide(scope));

          yield* driver.ready.pipe(Effect.timeout("5 seconds"));

          yield* Effect.promise(() => server.close());
          yield* Effect.sleep("300 millis");
          const restarted = yield* Effect.promise(() =>
            startMockObsServer({ port: server.port }),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => restarted.close()));

          const response = yield* Effect.gen(function* () {
            while (true) {
              const exit = yield* driver.request("GetVersion", {}).pipe(Effect.exit);
              if (Exit.isSuccess(exit)) return exit.value;
              yield* Effect.sleep("200 millis");
            }
          }).pipe(Effect.timeout("10 seconds"));

          expect(response).toMatchObject({ obsWebSocketVersion: "5.7.0" });
        }),
      ),
    20_000,
  );

  it.live(
    "publishes subscribed events on the agent bus and validates request input",
    () =>
      withServer({}, (server) =>
        Effect.gen(function* () {
          const published = yield* Queue.unbounded<{
            readonly key: string;
            readonly payload: unknown;
          }>();
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const driver = yield* startObsDriver({
            slot: "main",
            url: server.url,
            topics: ["obs/CurrentProgramSceneChanged"],
            publish: (key, payload) => Queue.offerUnsafe(published, { key, payload }),
          }).pipe(Scope.provide(scope));

          yield* driver.ready.pipe(Effect.timeout("5 seconds"));

          const response = yield* driver.request("GetSceneList", {});
          expect(response).toMatchObject({ currentProgramSceneName: "Scene 1" });

          const invalid = yield* driver
            .request("SetCurrentProgramScene", { sceneName: 42 })
            .pipe(Effect.flip);
          expect(invalid).toContain("Invalid SetCurrentProgramScene input");

          yield* Effect.sync(() => {
            server.emit("CurrentProgramSceneChanged", {
              sceneName: "Scene 2",
              sceneUuid: "uuid-Scene-2",
            });
          });

          const event = yield* Queue.take(published).pipe(Effect.timeout("2 seconds"));
          expect(event).toEqual({
            key: "obs/main/obs/CurrentProgramSceneChanged",
            payload: { sceneName: "Scene 2", sceneUuid: "uuid-Scene-2" },
          });
        }),
      ),
    10_000,
  );
});
