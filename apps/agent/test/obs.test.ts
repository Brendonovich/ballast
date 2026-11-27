import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { startObsDriver } from "../src/obs-driver.ts";
import type { ObsDriverStatus } from "../src/obs-driver.ts";
import type { ObsEventPacket } from "../src/obs-protocol.ts";
import { connectObsSocket } from "../src/obs-protocol.ts";
import { startMockObsServer } from "./mock-obs-server.ts";

const withServer = <A, E>(
  options: { readonly password?: string },
  use: (
    server: Awaited<ReturnType<typeof startMockObsServer>>,
  ) => Effect.Effect<A, E, SecureRandom.SecureRandom | Scope.Scope>,
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

const takeStatus = (
  queue: Queue.Queue<ObsDriverStatus>,
  predicate: (status: ObsDriverStatus) => boolean,
): Effect.Effect<ObsDriverStatus, Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const status = yield* Queue.take(queue).pipe(
        Effect.timeout("8 seconds"),
        Effect.orDie,
      );
      if (predicate(status)) return status;
    }
    return yield* Effect.fail(new Error("status did not arrive"));
  });

const drainStatuses = (
  queue: Queue.Queue<ObsDriverStatus>,
): Effect.Effect<ReadonlyArray<ObsDriverStatus>> =>
  Effect.gen(function* () {
    const values: Array<ObsDriverStatus> = [];
    let next = yield* Queue.poll(queue);
    while (Option.isSome(next)) {
      values.push(next.value);
      next = yield* Queue.poll(queue);
    }
    return values;
  });

const drainStates = (
  queue: Queue.Queue<{ readonly key: string; readonly payload: unknown }>,
): Effect.Effect<ReadonlyArray<unknown>> =>
  Effect.gen(function* () {
    const values: Array<unknown> = [];
    let next = yield* Queue.poll(queue);
    while (Option.isSome(next)) {
      values.push(next.value.payload);
      next = yield* Queue.poll(queue);
    }
    return values;
  });

describe("obs driver", () => {
  it.live(
    "publishes connection state for a service-relative topic name",
    () =>
      withServer({}, (server) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const states = yield* Queue.unbounded<{
            readonly key: string;
            readonly payload: unknown;
          }>();

          const driver = yield* startObsDriver({
            slot: "main",
            url: server.url,
            topics: ["ConnectionState"],
            publish: (key, payload) => Queue.offerUnsafe(states, { key, payload }),
          }).pipe(Scope.provide(scope));

          yield* driver.ready.pipe(Effect.timeout("5 seconds"));
          const state = yield* Queue.take(states);
          expect(state).toMatchObject({
            key: "obs/main/obs/ConnectionState",
            payload: { state: "connected", reconnected: false },
          });
        }),
      ),
    10_000,
  );

  it.live(
    "reconnects with backoff after the server restarts",
    () =>
      withServer({}, (server) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const states = yield* Queue.unbounded<{
            readonly key: string;
            readonly payload: unknown;
          }>();

          const driver = yield* startObsDriver({
            slot: "main",
            url: server.url,
            topics: ["obs/ConnectionState"],
            publish: (key, payload) => Queue.offerUnsafe(states, { key, payload }),
          }).pipe(Scope.provide(scope));

          yield* driver.ready.pipe(Effect.timeout("5 seconds"));

          const first = yield* Queue.take(states);
          expect(first).toMatchObject({
            key: "obs/main/obs/ConnectionState",
            payload: { state: "connected", reconnected: false },
          });

          yield* Effect.promise(() => server.close());
          yield* Effect.sleep("300 millis");
          const disconnected = yield* Queue.take(states);
          expect(disconnected).toMatchObject({
            key: "obs/main/obs/ConnectionState",
            payload: { state: "disconnected", reconnected: false },
          });

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

          const reconnected = yield* Queue.take(states);
          expect(reconnected).toMatchObject({
            key: "obs/main/obs/ConnectionState",
            payload: { state: "connected", reconnected: true },
          });
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
          expect(invalid.message).toContain("Invalid SetCurrentProgramScene input");

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

  it.live(
    "fails requests with a typed ConnectionUnavailable while disconnected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* startObsDriver({
            slot: "main",
            url: "ws://127.0.0.1:1",
            topics: [],
            publish: () => {},
          });
          const error = yield* driver.request("GetSceneList", {}).pipe(Effect.flip);
          expect(error._tag).toBe("ConnectionUnavailable");
          if (error._tag === "ConnectionUnavailable") {
            expect(error.integration).toBe("obs");
            expect(error.slot).toBe("main");
          }
        }),
      ).pipe(Effect.provide(NodeCrypto.layer)),
    10_000,
  );

  it.live(
    "reports disconnected between retries, recovers and publishes state once",
    () =>
      Effect.gen(function* () {
        const existing = yield* Effect.promise(() => startMockObsServer());
        const port = existing.port;
        const url = existing.url;
        yield* Effect.promise(() => existing.close());

        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const statuses = yield* Queue.unbounded<ObsDriverStatus>();
        const states = yield* Queue.unbounded<{
          readonly key: string;
          readonly payload: unknown;
        }>();
        const driver = yield* startObsDriver({
          slot: "main",
          url,
          topics: ["ConnectionState"],
          publish: (key, payload) => Queue.offerUnsafe(states, { key, payload }),
        }).pipe(Scope.provide(scope));
        yield* driver.statuses.pipe(
          Stream.runForEach((status) => Queue.offer(statuses, status)),
          Effect.forkIn(scope),
        );

        const connecting = yield* Queue.take(statuses).pipe(Effect.timeout("3 seconds"));
        expect(connecting._tag).toBe("connecting");

        const disconnected = yield* takeStatus(
          statuses,
          (status) => status._tag === "disconnected",
        );
        if (disconnected._tag !== "disconnected") throw new Error("expected disconnected");
        expect(disconnected.error).toContain("OBS not reachable at " + url);
        expect(disconnected.retryAt).toBeGreaterThan(Date.now());

        yield* Effect.sleep("1.5 seconds");
        const betweenRetries = yield* drainStatuses(statuses);
        expect(betweenRetries.every((status) => status._tag === "disconnected")).toBe(true);

        const restarted = yield* Effect.promise(() => startMockObsServer({ port }));
        yield* Effect.addFinalizer(() => Effect.promise(() => restarted.close()));

        const connected = yield* takeStatus(
          statuses,
          (status) => status._tag === "connected",
        );
        expect(connected._tag).toBe("connected");
        const connectedState = yield* Queue.take(states).pipe(Effect.timeout("3 seconds"));
        expect(connectedState.payload).toMatchObject({ state: "connected" });

        yield* Effect.promise(() => restarted.close());
        const dropped = yield* takeStatus(
          statuses,
          (status) => status._tag === "disconnected",
        );
        expect(dropped._tag).toBe("disconnected");
        const disconnectedState = yield* Queue.take(states).pipe(Effect.timeout("3 seconds"));
        expect(disconnectedState.payload).toMatchObject({ state: "disconnected" });

        yield* Effect.sleep("2 seconds");
        expect(yield* drainStates(states)).toEqual([]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
    20_000,
  );

  it.live(
    "stops retrying after an authentication failure",
    () =>
      withServer({ password: "hunter2" }, (server) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const statuses = yield* Queue.unbounded<ObsDriverStatus>();
          const states = yield* Queue.unbounded<{
            readonly key: string;
            readonly payload: unknown;
          }>();
          const driver = yield* startObsDriver({
            slot: "main",
            url: server.url,
            password: "wrong",
            topics: ["ConnectionState"],
            publish: (key, payload) => Queue.offerUnsafe(states, { key, payload }),
          }).pipe(Scope.provide(scope));
          yield* driver.statuses.pipe(
            Stream.runForEach((status) => Queue.offer(statuses, status)),
            Effect.forkIn(scope),
          );

          const connecting = yield* Queue.take(statuses).pipe(Effect.timeout("3 seconds"));
          expect(connecting._tag).toBe("connecting");
          const failed = yield* takeStatus(statuses, (status) => status._tag === "error");
          if (failed._tag !== "error") throw new Error("expected error");
          expect(failed.error).toContain("authentication failed");

          yield* Effect.sleep("1.5 seconds");
          expect(yield* drainStatuses(statuses)).toEqual([]);
          expect(yield* drainStates(states)).toEqual([]);
        }),
      ),
    10_000,
  );
});
