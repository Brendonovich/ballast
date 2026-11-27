import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Socket } from "effect/socket";
import type { ParamOptionSource } from "@ballast/core";
import {
  VTubeStudioConfigError,
  VTubeStudioDriver,
  fileTokenStore,
  normalizeUrl,
  tokenPath,
} from "../src/driver/index.ts";
import type {
  VTubeStudioDriverOptions,
  VTubeStudioDriverService,
  VTubeStudioDriverStatus,
} from "../src/driver/index.ts";
import type { StoredVTubeStudioToken, VTubeStudioTokenStore } from "../src/driver/token-store.ts";
import { startMockVtsServer } from "./mock-server.ts";
import type { MockVtsReply, MockVtsRequest, MockVtsServer } from "./mock-server.ts";

interface RecordedEvent {
  readonly key: string;
  readonly payload: unknown;
}

interface MemoryTokenStore extends VTubeStudioTokenStore {
  readonly tokens: Map<string, StoredVTubeStudioToken>;
}

const memoryTokenStore = (initial?: StoredVTubeStudioToken): MemoryTokenStore => {
  const tokens = new Map<string, StoredVTubeStudioToken>();
  if (initial !== undefined) tokens.set(initial.slot, initial);
  return {
    tokens,
    read: (slot) => Effect.sync(() => tokens.get(slot)),
    write: (token) =>
      Effect.sync(() => {
        tokens.set(token.slot, token);
      }),
    remove: (slot) =>
      Effect.sync(() => {
        tokens.delete(slot);
      }),
  };
};

const storedToken = (url: string, token: string): StoredVTubeStudioToken => ({
  version: 1,
  slot: "main",
  url,
  pluginName: "Ballast",
  pluginDeveloper: "Ballast",
  authenticationToken: token,
  updatedAt: 0,
});

const baseOptions = (
  url: string,
  extra: Partial<VTubeStudioDriverOptions> = {},
): VTubeStudioDriverOptions => ({
  slot: "main",
  url,
  pluginName: "Ballast",
  pluginDeveloper: "Ballast",
  reconnect: { initialDelay: "10 millis", maxDelay: "50 millis" },
  requestTimeout: "2 seconds",
  approvalTimeout: "2 seconds",
  ...extra,
});

const poll = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const value = yield* read;
      if (predicate(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for " + label));
  });

const waitForState = (
  driver: VTubeStudioDriverService,
  state: VTubeStudioDriverStatus["state"],
): Effect.Effect<VTubeStudioDriverStatus, Error> =>
  poll(driver.status, (status) => status.state === state, state);

const waitForRequest = (
  server: MockVtsServer,
  predicate: (request: MockVtsRequest) => boolean,
  label: string,
): Effect.Effect<MockVtsRequest, Error> =>
  poll(
    Effect.sync(() => server.requests()),
    (requests) => requests.some(predicate),
    label,
  ).pipe(
    Effect.map((requests) => {
      const found = requests.find(predicate);
      if (found === undefined) throw new Error("Unreachable: request disappeared");
      return found;
    }),
  );

const withDriver = <A, E>(
  options: VTubeStudioDriverOptions,
  body: (driver: VTubeStudioDriverService) => Effect.Effect<A, E>,
): Effect.Effect<A, E | VTubeStudioConfigError, never> =>
  Effect.gen(function* () {
    const driver = yield* VTubeStudioDriver;
    return yield* body(driver);
  }).pipe(
    Effect.provide(VTubeStudioDriver.layer(options)),
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    Effect.provide([NodeServices.layer, NodeCrypto.layer]),
  );

const apiState: MockVtsReply = {
  type: "data",
  data: {
    active: true,
    vTubeStudioVersion: "1.9.0",
    currentSessionAuthenticated: false,
  },
};

const standardHandler =
  (onRequest?: (request: MockVtsRequest) => MockVtsReply | undefined) =>
  (request: MockVtsRequest): MockVtsReply => {
    const custom = onRequest?.(request);
    if (custom !== undefined) return custom;
    switch (request.requestType) {
      case "APIState":
        return apiState;
      case "AuthenticationToken":
        return { type: "data", data: { authenticationToken: "token-1" } };
      case "Authentication":
        return {
          type: "data",
          data: { authenticated: request.data["authenticationToken"] === "token-1" },
        };
      default:
        return { type: "data" };
    }
  };

describe("VTube Studio driver", () => {
  it.live("requests a token, authenticates and round-trips a request", () =>
    Effect.gen(function* () {
      const server = yield* startMockVtsServer(
        standardHandler((request) =>
          request.requestType === "Statistics"
            ? {
                type: "data",
                data: {
                  uptime: 10,
                  framerate: 60,
                  vTubeStudioVersion: "1.9.0",
                  allowedPlugins: 1,
                  connectedPlugins: 1,
                  startedWithSteam: false,
                  windowWidth: 1920,
                  windowHeight: 1080,
                  windowIsFullscreen: false,
                },
              }
            : undefined,
        ),
      );
      const tokens = memoryTokenStore();

      yield* withDriver(baseOptions(server.url, { tokenStore: tokens }), (driver) =>
        Effect.gen(function* () {
          const status = yield* waitForState(driver, "connected");
          expect(status.authenticated).toBe(true);
          expect(status.vTubeStudioVersion).toBe("1.9.0");
          expect(status.url).toBe(normalizeUrl(server.url));

          const statistics = yield* driver.invoke("Statistics", {});
          expect(statistics.framerate).toBe(60);

          const token = tokens.tokens.get("main");
          expect(token?.authenticationToken).toBe("token-1");
          expect(token?.version).toBe(1);

          const requestTypes = server.requests().map((request) => request.requestType);
          expect(requestTypes.indexOf("APIState")).toBeLessThan(
            requestTypes.indexOf("AuthenticationToken"),
          );
          expect(requestTypes.indexOf("AuthenticationToken")).toBeLessThan(
            requestTypes.lastIndexOf("Authentication"),
          );
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("waits for the user to allow the plugin", () =>
    Effect.gen(function* () {
      const server = yield* startMockVtsServer(
        standardHandler((request) => {
          if (request.requestType === "AuthenticationToken") {
            return { type: "ignore" };
          }
          return undefined;
        }),
      );
      const tokens = memoryTokenStore();

      yield* withDriver(baseOptions(server.url, { tokenStore: tokens }), (driver) =>
        Effect.gen(function* () {
          const waiting = yield* waitForState(driver, "waiting-for-approval");
          expect(waiting.message ?? "").toContain("Allow");
          expect(tokens.tokens.size).toBe(0);

          const request = yield* waitForRequest(
            server,
            (candidate) => candidate.requestType === "AuthenticationToken",
            "the authentication token request",
          );
          yield* Effect.sync(() => server.reply(request, { authenticationToken: "token-1" }));

          const connected = yield* waitForState(driver, "connected");
          expect(connected.authenticated).toBe(true);
          expect(tokens.tokens.get("main")?.authenticationToken).toBe("token-1");
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("re-requests a token when the stored one was revoked", () =>
    Effect.gen(function* () {
      const server = yield* startMockVtsServer(
        standardHandler((request) => {
          if (request.requestType === "Authentication") {
            const token = request.data["authenticationToken"];
            return {
              type: "data",
              data:
                token === "old"
                  ? { authenticated: false, reason: "revoked" }
                  : { authenticated: token === "new" },
            };
          }
          if (request.requestType === "AuthenticationToken") {
            return { type: "data", data: { authenticationToken: "new" } };
          }
          return undefined;
        }),
      );
      const tokens = memoryTokenStore(storedToken(server.url, "old"));

      yield* withDriver(baseOptions(server.url, { tokenStore: tokens }), (driver) =>
        Effect.gen(function* () {
          yield* waitForState(driver, "connected");
          expect(tokens.tokens.get("main")?.authenticationToken).toBe("new");
          const authentications = server
            .requests()
            .filter((request) => request.requestType === "Authentication");
          expect(authentications.length).toBeGreaterThanOrEqual(2);
          expect(
            server.requests().some((request) => request.requestType === "AuthenticationToken"),
          ).toBe(true);
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("subscribes from topics, publishes events and unsubscribes", () =>
    Effect.gen(function* () {
      const events: Array<RecordedEvent> = [];
      const server = yield* startMockVtsServer(
        standardHandler((request) =>
          request.requestType === "EventSubscription"
            ? {
                type: "data",
                data: {
                  subscribedEventCount: 1,
                  subscribedEvents: [String(request.data["eventName"] ?? "")],
                },
              }
            : undefined,
        ),
      );

      const options = baseOptions(server.url, {
        tokenStore: memoryTokenStore(),
        subscriptions: [
          {
            topic: "vts/HotkeyTriggered",
            condition: {
              config: JSON.stringify({ ignoreHotkeysTriggeredByAPI: true }),
            },
          },
        ],
        publish: (key, payload) => events.push({ key, payload }),
      });

      yield* withDriver(options, (driver) =>
        Effect.gen(function* () {
          yield* waitForState(driver, "connected");
          const subscribe = yield* waitForRequest(
            server,
            (request) =>
              request.requestType === "EventSubscription" &&
              request.data["subscribe"] === true,
            "EventSubscription",
          );
          expect(subscribe.data["eventName"]).toBe("HotkeyTriggeredEvent");
          expect(subscribe.data["config"]).toEqual({ ignoreHotkeysTriggeredByAPI: true });

          yield* Effect.sync(() =>
            server.sendEvent("HotkeyTriggeredEvent", {
              hotkeyID: "h1",
              hotkeyName: "Smile",
              hotkeyAction: "ToggleExpression",
              hotkeyFile: "smile.exp3.json",
              hotkeyTriggeredByAPI: false,
              modelID: "m1",
              modelName: "Akari",
              isLive2DItem: false,
            }),
          );
          yield* poll(
            Effect.sync(() => events.length),
            (length) => length >= 1,
            "a published event",
          );
          expect(events[0]?.key).toBe("vts/main/vts/HotkeyTriggered");
          expect(events[0]?.payload).toMatchObject({ hotkeyName: "Smile" });

          yield* driver.setTopics([]);
          yield* waitForRequest(
            server,
            (request) =>
              request.requestType === "EventSubscription" &&
              request.data["subscribe"] === false,
            "EventSubscription unsubscribe",
          );
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("re-requests a token when access is revoked mid-session", () =>
    Effect.gen(function* () {
      let revoke = false;
      const server = yield* startMockVtsServer(
        standardHandler((request) => {
          if (request.requestType === "Authentication") {
            return { type: "data", data: { authenticated: true } };
          }
          if (request.requestType === "AuthenticationToken") {
            return { type: "data", data: { authenticationToken: "token-2" } };
          }
          if (request.requestType === "Statistics" && revoke) {
            return { type: "error", errorID: 50, message: "Plugin access revoked" };
          }
          return undefined;
        }),
      );
      const tokens = memoryTokenStore(storedToken(server.url, "token-1"));

      yield* withDriver(baseOptions(server.url, { tokenStore: tokens }), (driver) =>
        Effect.gen(function* () {
          yield* waitForState(driver, "connected");
          revoke = true;
          const failure = yield* Effect.flip(driver.request("Statistics", {}));
          expect(failure._tag).toBe("VTubeStudioRequestError");
          if (failure._tag === "VTubeStudioRequestError") {
            expect(failure.code).toBe(50);
          }

          yield* poll(
            Effect.sync(() => tokens.tokens.get("main")?.authenticationToken),
            (token) => token === "token-2",
            "a re-requested token",
          );
          yield* waitForState(driver, "connected");
          expect(
            server.requests().some((request) => request.requestType === "AuthenticationToken"),
          ).toBe(true);
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("reconnects, authenticates and re-subscribes", () =>
    Effect.gen(function* () {
      const events: Array<RecordedEvent> = [];
      const server = yield* startMockVtsServer(
        standardHandler((request) =>
          request.requestType === "EventSubscription"
            ? {
                type: "data",
                data: { subscribedEventCount: 1, subscribedEvents: ["TestEvent"] },
              }
            : undefined,
        ),
      );

      yield* withDriver(
        baseOptions(server.url, {
          tokenStore: memoryTokenStore(),
          subscriptions: [{ topic: "vts/Test" }],
          publish: (key, payload) => events.push({ key, payload }),
        }),
        (driver) =>
          Effect.gen(function* () {
            yield* waitForState(driver, "connected");
            expect(server.connections()).toBe(1);

            yield* Effect.sync(() => server.closeClients());
            yield* poll(
              Effect.sync(() => server.connections()),
              (count) => count >= 2,
              "a second connection",
            );
            yield* waitForState(driver, "connected");

            const authentications = server
              .requests()
              .filter((request) => request.requestType === "Authentication");
            expect(authentications.length).toBeGreaterThanOrEqual(2);

            yield* waitForRequest(
              server,
              (request) =>
                request.connection >= 2 &&
                request.requestType === "EventSubscription" &&
                request.data["eventName"] === "TestEvent",
              "re-subscription",
            );

            yield* Effect.sync(() =>
              server.sendEvent("TestEvent", { yourTestMessage: "hello", counter: 3 }),
            );
            yield* poll(
              Effect.sync(() => events.length),
              (length) => length >= 1,
              "an event after reconnect",
            );
            expect(events[0]?.key).toBe("vts/main/vts/Test");
          }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("resolves model, hotkey and expression options", () =>
    Effect.gen(function* () {
      const server = yield* startMockVtsServer(
        standardHandler((request) => {
          switch (request.requestType) {
            case "AvailableModels":
              return {
                type: "data",
                data: {
                  numberOfModels: 2,
                  availableModels: [
                    {
                      modelLoaded: true,
                      modelName: "Akari",
                      modelID: "model-1",
                      vtsModelName: "Akari.vtube.json",
                      vtsModelIconName: "Akari.png",
                    },
                    {
                      modelLoaded: false,
                      modelName: "Mao",
                      modelID: "model-2",
                      vtsModelName: "Mao.vtube.json",
                      vtsModelIconName: "",
                    },
                  ],
                },
              };
            case "HotkeysInCurrentModel":
              return {
                type: "data",
                data: {
                  modelLoaded: true,
                  modelName: "Akari",
                  modelID: "model-1",
                  availableHotkeys: [
                    {
                      name: "Smile",
                      type: "ToggleExpression",
                      description: "",
                      file: "smile.exp3.json",
                      hotkeyID: "hotkey-1",
                      keyCombination: [],
                      onScreenButtonID: -1,
                    },
                    {
                      name: "",
                      type: "MoveModel",
                      description: "",
                      file: "",
                      hotkeyID: "hotkey-2",
                      keyCombination: [],
                      onScreenButtonID: -1,
                    },
                  ],
                },
              };
            case "ExpressionState":
              return {
                type: "data",
                data: {
                  modelLoaded: true,
                  modelName: "Akari",
                  modelID: "model-1",
                  expressions: [
                    {
                      name: "smile",
                      file: "smile.exp3.json",
                      active: false,
                      deactivateWhenKeyIsLetGo: false,
                      autoDeactivateAfterSeconds: false,
                      secondsRemaining: 0,
                      usedInHotkeys: [],
                      parameters: [],
                    },
                  ],
                },
              };
            default:
              return undefined;
          }
        }),
      );

      yield* withDriver(baseOptions(server.url, { tokenStore: memoryTokenStore() }), (driver) =>
        Effect.gen(function* () {
          yield* waitForState(driver, "connected");
          expect(
            yield* driver.resolveOptions({ integration: "vts", slot: "main", source: "models" }),
          ).toEqual(["model-1", "model-2"]);
          expect(
            yield* driver.resolveOptions({
              integration: "vts",
              slot: "main",
              source: "hotkeys",
            }),
          ).toEqual(["Smile", "hotkey-2"]);
          expect(
            yield* driver.resolveOptions({
              integration: "vts",
              slot: "main",
              source: "expressions",
            }),
          ).toEqual(["smile.exp3.json"]);

          const wrongSlot: ParamOptionSource = {
            integration: "vts",
            slot: "other",
            source: "models",
          };
          const failure = yield* Effect.flip(driver.resolveOptions(wrongSlot));
          expect(failure._tag).toBe("VTubeStudioOptionError");
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("maps APIError responses to typed request errors", () =>
    Effect.gen(function* () {
      const server = yield* startMockVtsServer(
        standardHandler((request) =>
          request.requestType === "ModelLoad"
            ? { type: "error", errorID: 152, message: "Model not found" }
            : undefined,
        ),
      );

      yield* withDriver(baseOptions(server.url, { tokenStore: memoryTokenStore() }), (driver) =>
        Effect.gen(function* () {
          yield* waitForState(driver, "connected");
          const failure = yield* Effect.flip(
            driver.request("ModelLoad", { modelID: "missing" }),
          );
          expect(failure._tag).toBe("VTubeStudioRequestError");
          if (failure._tag === "VTubeStudioRequestError") {
            expect(failure.code).toBe(152);
            expect(failure.message).toContain("ModelIDNotFound");
          }
        }),
      );
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.live("persists the token in the data dir with mode 0600", () =>
    Effect.gen(function* () {
      const dataDir = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "ballast-vts-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      );
      const server = yield* startMockVtsServer(standardHandler());

      yield* withDriver(
        baseOptions(server.url, { tokenStore: fileTokenStore(dataDir) }),
        (driver) =>
          Effect.gen(function* () {
            yield* waitForState(driver, "connected");
          }),
      );

      const paths = yield* Path.Path;
      const path = tokenPath(paths, "main", dataDir);
      const contents = yield* Effect.tryPromise(() => readFile(path, "utf8"));
      const decoded = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            version: Schema.Literal(1),
            authenticationToken: Schema.String,
          }),
        ),
      )(contents);
      expect(decoded.authenticationToken).toBe("token-1");

      if (process.platform !== "win32") {
        const info = yield* Effect.tryPromise(() => stat(path));
        expect(info.mode & 0o777).toBe(0o600);
      }
    }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.provide([NodeServices.layer, NodeCrypto.layer]),
    ),
  );
});
