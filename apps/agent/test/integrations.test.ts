import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";
import { startMockVtsServer } from "../../../packages/integrations/vtube-studio/test/mock-server.ts";
import type { MockVtsReply, MockVtsRequest } from "../../../packages/integrations/vtube-studio/test/mock-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const agentNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const vtsScript = `import * as Ballast from "@ballast/core";
import * as VTS from "@ballast/module-vtube-studio";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const vts = yield* VTS.Connection("main");
  const hotkey = yield* Ballast.Param.string("hotkey", { options: VTS.hotkeys(vts), default: "Wave" });
  yield* VTS.HotkeyTriggered.subscribe("hotkey", vts, (event) => Effect.log("hotkey " + event.hotkeyName), { ignoreHotkeysTriggeredByAPI: true });
  yield* Ballast.run("vts-loop", Effect.gen(function* () {
    yield* vts.HotkeyTrigger({ hotkeyID: yield* hotkey });
    yield* Effect.log("vts triggered");
    yield* Effect.never;
  }));
});
`;

const wsServerScript = `import * as Ballast from "@ballast/core";
import * as WebSocket from "@ballast/module-websocket";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const bridge = yield* WebSocket.Server("bridge", { port: 0, path: "/bridge" });
  yield* WebSocket.ServerMessage.subscribe("server-message", bridge, (message) =>
    message.text === undefined ? Effect.void : Effect.log("ws server " + message.text),
  );
});
`;

const wsClientScript = `import * as Ballast from "@ballast/core";
import * as WebSocket from "@ballast/module-websocket";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const upstream = yield* WebSocket.Client("upstream");
  yield* WebSocket.Message.subscribe("client-message", upstream, (message) =>
    message.text === undefined ? Effect.void : Effect.log("ws client " + message.text),
  );
});
`;

const httpClientScript = `import * as Ballast from "@ballast/core";
import * as Http from "@ballast/module-http";
import { Effect, Schema } from "effect";

const Summary = Schema.Struct({ total: Schema.Number });

export default Effect.gen(function* () {
  const api = yield* Http.Client("api", { hosts: ["127.0.0.1"] });
  yield* Ballast.run("http-loop", Effect.gen(function* () {
    const response = yield* api.get("/summary", { schema: Summary });
    yield* Effect.log("http total " + response.body.total);
    yield* Effect.never;
  }));
});
`;

const httpWebhookScript = `import * as Ballast from "@ballast/core";
import * as Http from "@ballast/module-http";
import { Effect, Schema } from "effect";

const Donation = Schema.Struct({ from: Schema.String, amount: Schema.Number });

export default Effect.gen(function* () {
  const hook = yield* Http.Webhook("kofi");
  yield* Http.Webhook.json(Donation).subscribe("donation", hook, (donation) =>
    Effect.log("donation " + donation.from + " " + donation.amount),
  );
});
`;

const keyboardScript = `import * as Ballast from "@ballast/core";
import * as Keyboard from "@ballast/module-keyboard";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const keyboard = yield* Keyboard.Connection("main");
  yield* Keyboard.KeyDown.subscribe("key-down", keyboard, (event) => Effect.log("keydown " + event.key));
});
`;

const midiScript = `import * as Ballast from "@ballast/core";
import * as Midi from "@ballast/module-midi";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const midi = yield* Midi.Connection("controller");
  yield* Midi.NoteOn.subscribe("note-on", midi, (event) => Effect.log("midi note " + event.note));
});
`;

interface ServiceProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exit: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

const spawnService = (
  env: Readonly<Record<string, string>>,
  dev: boolean,
): Effect.Effect<ServiceProcess> =>
  Effect.sync(() => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        bin,
        "serve",
        "--port",
        "0",
        ...(dev ? ["--dev"] : []),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const exit = Deferred.makeUnsafe<number>();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      Deferred.doneUnsafe(exit, Exit.succeed(code ?? -1));
    });
    return {
      child,
      output: () => output,
      exit: Deferred.await(exit),
      kill: Effect.gen(function* () {
        if (child.exitCode !== null) return;
        child.kill("SIGKILL");
        yield* Deferred.await(exit);
      }),
    };
  });

const sleep = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`);

const waitFor = <A, E>(
  label: string,
  effect: Effect.Effect<A | undefined, E>,
  output: () => string,
  timeoutMs = 25_000,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = yield* effect;
      if (value !== undefined) return value;
      yield* sleep(100);
    }
    return yield* Effect.fail(
      new Error(`Timed out waiting for ${label}\n--- service output ---\n${output()}`),
    );
  });

const makeProject = (root: string, scripts: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(join(root, "scripts"), { recursive: true }));
    yield* Effect.promise(() => mkdir(join(root, "node_modules", "@ballast"), { recursive: true }));
    for (const pkg of ["core", "fake", "module-obs", "module-vtube-studio", "module-websocket", "module-http", "module-keyboard", "module-midi"]) {
      yield* Effect.promise(() =>
        symlink(join(agentNodeModules, "@ballast", pkg), join(root, "node_modules", "@ballast", pkg), "dir"),
      );
    }
    yield* Effect.promise(() =>
      symlink(join(agentNodeModules, "effect"), join(root, "node_modules", "effect"), "dir"),
    );
    for (const [name, source] of Object.entries(scripts)) {
      yield* Effect.promise(() => writeFile(join(root, "scripts", name), source, "utf8"));
    }
  });

const vtsHandler = (request: MockVtsRequest): MockVtsReply => {
  switch (request.requestType) {
    case "APIState":
      return { type: "data", data: { active: true, vTubeStudioVersion: "1.9.0", currentSessionAuthenticated: false } };
    case "AuthenticationToken":
      return { type: "data", data: { authenticationToken: "token-1" } };
    case "Authentication":
      return { type: "data", data: { authenticated: request.data["authenticationToken"] === "token-1" } };
    case "HotkeysInCurrentModel":
      return {
        type: "data",
        data: {
          modelLoaded: true,
          modelName: "Model",
          modelID: "model-1",
          availableHotkeys: [
            { name: "Wave", type: "TriggerAnimation", description: "", file: "wave.motion3.json", hotkeyID: "hotkey-1", keyCombination: [], onScreenButtonID: 0 },
          ],
        },
      };
    case "HotkeyTrigger":
      return { type: "data", data: { hotkeyID: request.data["hotkeyID"] } };
    default:
      return { type: "data" };
  }
};

describe("integration drivers through the service", () => {
  it.live(
    "VTS, WebSocket client/server and HTTP client/local webhook",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-drivers-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));
        yield* makeProject(project, {
          "vts.ts": vtsScript,
          "ws-server.ts": wsServerScript,
          "ws-client.ts": wsClientScript,
          "http-client.ts": httpClientScript,
          "http-webhook.ts": httpWebhookScript,
        });

        const vts = yield* Effect.acquireRelease(
          startMockVtsServer(vtsHandler),
          (server) => Effect.sync(() => server.server.close()),
        );

        const httpServer = yield* Effect.acquireRelease(
          Effect.promise(() => new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
            const server = createServer((request, response) => {
              if (request.url === "/summary") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ total: 5 }));
                return;
              }
              response.writeHead(404);
              response.end();
            });
            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (address === null || typeof address === "string") return reject(new Error("no address"));
              resolve({
                url: "http://127.0.0.1:" + address.port,
                close: () => new Promise<void>((done) => server.close(() => done())),
              });
            });
          })),
          (server) => Effect.promise(() => server.close()),
        );

        const wsServer = yield* Effect.acquireRelease(
          Effect.promise(() => new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
            const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
            server.on("connection", (socket) => {
              setTimeout(() => socket.send("hello client"), 1500);
            });
            server.on("error", reject);
            server.on("listening", () => {
              const address = server.address();
              if (address === null || typeof address === "string") return reject(new Error("no address"));
              resolve({
                url: "ws://127.0.0.1:" + address.port,
                close: () => new Promise<void>((done) => server.close(() => done())),
              });
            });
          })),
          (server) => Effect.promise(() => server.close()),
        );

        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };
        const service = yield* Effect.acquireRelease(spawnService(env, false), (process) => process.kill);
        const registration = yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)),
          service.output,
        );
        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
          withAgentClient(use, { ...env }).pipe(
            Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );

        yield* waitFor(
          "health",
          Effect.promise(async () => ((await fetch(`${registration.url}/health`)).ok ? true : undefined)),
          service.output,
        );

        const detail = yield* call((client) => client.AddProject({ path: project, name: "Drivers" }));
        const projectId = detail.summary.id;

        yield* call((client) =>
          client.ConfigureConnection({ connectionId: "vts/main", values: [{ key: "url", value: vts.url }] }),
        );
        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "websocket/bridge",
            values: [
              { key: "mode", value: "server" },
              { key: "serverPort", value: "0" },
              { key: "serverPath", value: "/bridge" },
            ],
          }),
        );
        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "websocket/upstream",
            values: [
              { key: "mode", value: "client" },
              { key: "url", value: wsServer.url },
            ],
          }),
        );
        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "http/api",
            values: [{ key: "baseUrl", value: httpServer.url }],
          }),
        );
        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "http/kofi",
            values: [
              { key: "webhookTransport", value: "local" },
              { key: "webhookPort", value: "0" },
              { key: "webhookPath", value: "/hooks/kofi" },
              { key: "webhookResponseStatus", value: "200" },
              { key: "webhookResponseBody", value: "ok" },
            ],
          }),
        );

        const vtsDetail = yield* call((client) => client.GetScript({ projectId, scriptId: "scripts/vts.ts" }));
        const hotkeyOptions = vtsDetail.manifest.params.find((param) => param.key === "hotkey")?.options;
        expect(hotkeyOptions).toEqual(["Wave"]);

        for (const scriptId of ["scripts/vts.ts", "scripts/ws-server.ts", "scripts/ws-client.ts", "scripts/http-client.ts", "scripts/http-webhook.ts"]) {
          yield* call((client) => client.StartScript({ projectId, scriptId })).pipe(Effect.exit);
        }
        for (let round = 0; round < 5; round++) {
          const consents = yield* call((client) => client.ListConsents({ projectId }));
          if (consents.consents.length === 0) break;
          for (const consent of consents.consents) {
            yield* call((client) => client.ApproveConsent({ consentId: consent.id }));
          }
          yield* sleep(200);
        }

        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("vts triggered")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const bridge = yield* waitFor(
          "websocket bridge address",
          call((client) => client.GetConnection({ connectionId: "websocket/bridge" })).pipe(
            Effect.map((connection) => connection.detail),
            Effect.map((detail) => (detail?.includes("/bridge") === true ? detail : undefined)),
          ),
          service.output,
        );
        const bridgePort = Number(/:(\d+)\//.exec(bridge)?.[1]);
        expect(bridgePort).toBeGreaterThan(0);
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge`);
            socket.on("open", () => socket.send("hello"));
            socket.on("error", reject);
            socket.on("message", () => {
              socket.close();
              resolve();
            });
            setTimeout(() => {
              socket.close();
              resolve();
            }, 1000);
          }),
        );
        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("ws server hello")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("ws client hello client")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("http total 5")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const hook = yield* waitFor(
          "webhook address",
          call((client) => client.GetConnection({ connectionId: "http/kofi" })).pipe(
            Effect.map((connection) => connection.detail),
            Effect.map((detail) => (detail?.includes("/hooks/kofi") === true ? detail : undefined)),
          ),
          service.output,
        );
        const hookPort = Number(/:([0-9]+)/.exec(hook)?.[1]);
        expect(hookPort).toBeGreaterThan(0);
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${hookPort}/hooks/kofi`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: "alice", amount: 5 }),
          }),
        );
        expect(response.status).toBe(200);
        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("donation alice 5")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        yield* call((client) => client.ShutdownService({ force: false }));
        yield* service.exit.pipe(Effect.timeout("20 seconds"));
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    120_000,
  );

  it.live(
    "reports VTube Studio approval separately from reauth",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-vts-approval-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));

        let tokenRequest: MockVtsRequest | undefined;
        const vts = yield* startMockVtsServer((request) => {
          switch (request.requestType) {
            case "APIState":
              return {
                type: "data",
                data: { active: true, vTubeStudioVersion: "1.9.0", currentSessionAuthenticated: false },
              };
            case "AuthenticationToken":
              tokenRequest = request;
              return { type: "ignore" };
            case "Authentication":
              return {
                type: "data",
                data: { authenticated: request.data["authenticationToken"] === "token-1" },
              };
            default:
              return { type: "data" };
          }
        });

        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
        };
        const service = yield* Effect.acquireRelease(spawnService(env, false), (process) => process.kill);
        const registration = yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)),
          service.output,
        );
        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
          withAgentClient(use, { ...env }).pipe(
            Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );
        yield* waitFor(
          "health",
          Effect.promise(async () => ((await fetch(`${registration.url}/health`)).ok ? true : undefined)),
          service.output,
        );

        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "vts/pending",
            values: [{ key: "url", value: vts.url }],
          }),
        );
        const connect = yield* Effect.forkChild(
          call((client) => client.ConnectConnection({ connectionId: "vts/pending" })),
        );
        const pending = yield* waitFor(
          "VTube Studio approval",
          call((client) => client.GetConnection({ connectionId: "vts/pending" })).pipe(
            Effect.map((connection) => (connection.approval === undefined ? undefined : connection)),
          ),
          service.output,
        );
        expect(pending.status).toBe("connecting");
        expect(pending.approval?.kind).toBe("vtuber-studio");
        expect(pending.approval?.message ?? "").toContain("Allow");
        expect(pending.requiresAuth).toBe(false);

        if (tokenRequest === undefined) {
          return yield* Effect.fail(new Error("VTube Studio did not request a token"));
        }
        vts.reply(tokenRequest, { authenticationToken: "token-1" });
        yield* Fiber.join(connect).pipe(Effect.timeout("20 seconds"));

        const connected = yield* waitFor(
          "VTube Studio connected",
          call((client) => client.GetConnection({ connectionId: "vts/pending" })).pipe(
            Effect.map((connection) => (connection.status === "connected" ? connection : undefined)),
          ),
          service.output,
        );
        expect(connected.approval).toBeUndefined();

        yield* call((client) => client.ShutdownService({ force: false }));
        yield* service.exit.pipe(Effect.timeout("20 seconds"));
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    60_000,
  );

  it.live(
    "keyboard and MIDI through the fake native backends",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-inputs-")));
        const stateDir = join(root, "state");
        const dataDir = join(root, "data");
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(stateDir, { recursive: true }));
        yield* Effect.promise(() => mkdir(dataDir, { recursive: true }));
        yield* makeProject(project, {
          "keyboard.ts": keyboardScript,
          "midi.ts": midiScript,
        });
        const env = {
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
          BALLAST_WEB_DIR: join(root, "missing-web"),
          BALLAST_DEV_FAKE_INPUT: "1",
        };
        const service = yield* Effect.acquireRelease(spawnService(env, true), (process) => process.kill);
        const registration = yield* waitFor(
          "service.json",
          readServiceRegistration(stateDir).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)),
          service.output,
        );
        const call = <A, E>(use: (client: LiveAgentClient) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
          withAgentClient(use, { ...env }).pipe(
            Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
            Effect.mapError((error) => {
              if (error instanceof Error) return error;
              if (typeof error === "object" && error !== null) {
                const message = (error as { message?: unknown }).message;
                if (typeof message === "string") return new Error(message);
              }
              return new Error(String(error));
            }),
          );
        yield* waitFor(
          "health",
          Effect.promise(async () => ((await fetch(`${registration.url}/health`)).ok ? true : undefined)),
          service.output,
        );
        const detail = yield* call((client) => client.AddProject({ path: project, name: "Inputs" }));
        const projectId = detail.summary.id;
        yield* call((client) =>
          client.ReportShellPermission({ permission: "accessibility", status: "denied" }),
        );
        yield* call((client) =>
          client.ConfigureConnection({
            connectionId: "midi/controller",
            values: [
              { key: "input", value: "Fake Controller" },
              { key: "output", value: "Fake Synth" },
            ],
          }),
        );
        for (const scriptId of ["scripts/keyboard.ts", "scripts/midi.ts"]) {
          yield* call((client) => client.StartScript({ projectId, scriptId })).pipe(Effect.exit);
        }
        for (let round = 0; round < 5; round++) {
          const consents = yield* call((client) => client.ListConsents({ projectId }));
          if (consents.consents.length === 0) break;
          for (const consent of consents.consents) {
            yield* call((client) => client.ApproveConsent({ consentId: consent.id }));
          }
          yield* sleep(200);
        }
        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("keydown F1")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));
        yield* call((client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("midi note 60")),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"));

        const denied = yield* waitFor(
          "keyboard accessibility approval",
          call((client) => client.GetConnection({ connectionId: "keyboard/main" })).pipe(
            Effect.map((connection) =>
              connection.approval?.kind === "accessibility" ? connection : undefined,
            ),
          ),
          service.output,
        );
        expect(denied.status).toBe("connected");
        expect(denied.label).toBe("Keyboard");
        expect(denied.approval?.status).toBe("denied");
        expect((yield* call((client) => client.GetHealth())).permissions?.accessibility).toBe("denied");

        yield* call((client) =>
          client.ReportShellPermission({ permission: "accessibility", status: "granted" }),
        );
        const granted = yield* waitFor(
          "keyboard accessibility granted",
          call((client) => client.GetConnection({ connectionId: "keyboard/main" })).pipe(
            Effect.map((connection) => (connection.approval === undefined ? connection : undefined)),
          ),
          service.output,
        );
        expect(granted.status).toBe("connected");
        expect((yield* call((client) => client.GetHealth())).permissions?.accessibility).toBe("granted");

        yield* call((client) => client.ShutdownService({ force: false }));
        yield* service.exit.pipe(Effect.timeout("20 seconds"));
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    120_000,
  );
});
