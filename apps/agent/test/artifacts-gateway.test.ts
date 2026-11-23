import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { WebSocket } from "ws";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const apiSource = [
  'import * as Ballast from "@ballast/core";',
  'import { Rpc } from "effect/rpc";',
  'import * as RpcGroup from "effect/rpc/RpcGroup";',
  'import * as Schema from "effect/Schema";',
  "",
  "export const DashboardApi = RpcGroup.make(",
  '  Rpc.make("Snapshot", {',
  "    success: Schema.Struct({ count: Schema.Number }),",
  "  }),",
  "  Ballast.Api.action(",
  '    Rpc.make("Increment", {',
  "      payload: { by: Schema.Number },",
  "      success: Schema.Number,",
  "    }),",
  "  ),",
  '  Rpc.make("Counts", {',
  "    stream: true,",
  "    success: Schema.Struct({ count: Schema.Number }),",
  "  }),",
  ");",
  "",
].join("\n");

const projectSource = [
  'import * as Ballast from "@ballast/core";',
  'import { Effect, Stream } from "effect";',
  'import { DashboardApi } from "./src/api.ts";',
  "",
  'export default Effect.gen(function* () {',
  '  const views = yield* Ballast.Store.counter("views", { initial: 0 });',
  '  const greeting = yield* Ballast.Param.string("greeting", { default: "hello" });',
  '  yield* Ballast.run("greeting", Effect.gen(function* () { yield* Effect.log(yield* greeting); }));',
  '  yield* Ballast.Artifact("dashboard", {',
  '    title: "Stream dashboard",',
  '    entry: "./artifacts/dashboard/main.ts",',
  "  });",
  '  yield* Ballast.Api.serve(DashboardApi, {',
  "    Snapshot: () =>",
  "      Effect.gen(function* () {",
  "        const count = yield* views.get;",
  "        return { count };",
  "      }),",
  "    Increment: ({ by }) => views.increment(by),",
  "    Counts: () =>",
  '      Stream.tick("50 millis").pipe(',
  "        Stream.mapEffect(() =>",
  "          Effect.gen(function* () {",
  "            const count: number = yield* views.get;",
  "            return { count };",
  "          }),",
  "        ),",
  "        Stream.take(3),",
  "      ),",
  "  });",
  "});",
  "",
].join("\n");

const artifactSource = [
  'const root = document.getElementById("root");',
  'if (root !== null) root.textContent = "dashboard-ready";',
  "",
].join("\n");

interface Service {
  readonly child: ChildProcess;
  readonly stop: () => Effect.Effect<void>;
}

const startService = (root: string): Effect.Effect<Service, Error> =>
  Effect.gen(function* () {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "serve", "--port", "0"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          BALLAST_STATE_DIR: join(root, "state"),
          BALLAST_DATA_DIR: join(root, "data"),
          BALLAST_LOG_DIR: join(root, "logs"),
          BALLAST_ARTIFACT_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const registration = yield* Effect.promise(() =>
        Effect.runPromise(
          readServiceRegistration(join(root, "state")).pipe(
            Effect.provide(NodeFileSystem.layer),
            Effect.provide(NodePath.layer),
            Effect.provide(NodeCrypto.layer),
          ),
        ),
      );
      if (registration?.pid === child.pid) {
        return {
          child,
          stop: () =>
            Effect.gen(function* () {
              if (child.exitCode !== null || child.signalCode !== null) return;
              child.kill("SIGTERM");
              const exitDeadline = Date.now() + 10_000;
              while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline) {
                yield* Effect.sleep("50 millis");
              }
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              yield* Effect.sleep("100 millis");
            }),
        };
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for the service"));
  });

const asError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return new Error(message);
  }
  return new Error(String(error));
};

const call = <A>(
  root: string,
  use: (client: LiveAgentClient) => Effect.Effect<A, unknown>,
): Effect.Effect<A, Error> =>
  withAgentClient(use, {
    BALLAST_STATE_DIR: join(root, "state"),
    BALLAST_DATA_DIR: join(root, "data"),
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(NodePath.layer),
    Effect.provide(NodeCrypto.layer),
    Effect.mapError(asError),
  );

const openSocket = (url: string, token: string, path = "/rpc") =>
  Effect.promise(
    () =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url + path + "?token=" + token);
        socket.once("open", () => resolve(socket));
        socket.once("unexpected-response", (_request, response) => {
          reject(new Error("unexpected response " + String(response.statusCode)));
        });
        socket.once("error", reject);
      }),
  );

const waitForMessage = (socket: WebSocket, predicate: (value: unknown) => boolean) =>
  Effect.promise(
    () =>
      new Promise<unknown>((resolve) => {
        const onMessage = (data: unknown) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof data === "string" ? data : String(data));
          } catch {
            return;
          }
          if (!predicate(parsed)) return;
          socket.off("message", onMessage);
          resolve(parsed);
        };
        socket.on("message", onMessage);
      }),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const tokenFromCopyUrl = (copyUrl: string): string => {
  const match = /\/a\/([^/]+)\//.exec(copyUrl);
  if (match === null || match[1] === undefined) throw new Error("copy URL has no token");
  return match[1];
};

const waitFor = <A>(
  label: string,
  read: () => Effect.Effect<A | undefined, Error>,
  timeoutMs = 20_000,
): Effect.Effect<A, Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* read();
      if (value !== undefined) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for " + label));
  });

const startProject = (root: string, projectId: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let round = 0; round < 50; round += 1) {
      yield* call(root, (client) => client.StartProject({ projectId })).pipe(
        Effect.catch(() => Effect.void),
      );
      const detail = yield* call(root, (client) => client.GetProject({ projectId }));
      if (detail.summary.status === "running") return;
      const consents = yield* call(root, (client) =>
        client.ListProjectConsents({ projectId }),
      );
      for (const consent of consents.consents) {
        yield* call(root, (client) =>
          client.ApproveProjectConsent({ consentId: consent.id }),
        );
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Project did not start"));
  });

describe("artifact gateway", () => {
  it.live(
    "serves artifacts, enforces scopes and forwards metadata + project API",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-artifacts-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(join(project, "src"), { recursive: true }));
        yield* Effect.promise(() => mkdir(join(project, "artifacts", "dashboard"), { recursive: true }));
        yield* Effect.promise(() => writeFile(join(project, "ballast.ts"), projectSource, "utf8"));
        yield* Effect.promise(() => writeFile(join(project, "src", "api.ts"), apiSource, "utf8"));
        yield* Effect.promise(() =>
          writeFile(join(project, "artifacts", "dashboard", "main.ts"), artifactSource, "utf8"),
        );

        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Artifacts" }),
        );
        if (added.summary.lastError !== undefined) {
          return yield* Effect.fail(new Error(added.summary.lastError));
        }
        yield* startProject(root, added.summary.id);

        const artifacts = yield* call(root, (client) =>
          client.ListArtifacts({ projectId: added.summary.id }),
        );
        expect(artifacts.artifacts.map((artifact) => artifact.name)).toEqual(["dashboard"]);

        const view = yield* call(root, (client) =>
          client.GetArtifactView({ projectId: added.summary.id, artifact: "dashboard" }),
        );
        expect(view.scope).toBe("action");
        const page = yield* Effect.promise(() => fetch(view.pageUrl));
        expect(page.status).toBe(200);
        const csp = page.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("connect-src ws://127.0.0.1:");
        expect(csp).toContain("frame-ancestors http://127.0.0.1:*");
        expect(yield* Effect.promise(() => page.text())).toContain("<div id=\"root\">");
        const script = yield* Effect.promise(() => fetch(new URL("main.js", view.pageUrl)));
        expect(script.status).toBe(200);
        expect(yield* Effect.promise(() => script.text())).toContain("dashboard-ready");

        const registration = yield* Effect.promise(() =>
          Effect.runPromise(
            readServiceRegistration(join(root, "state")).pipe(
              Effect.provide(NodeFileSystem.layer),
              Effect.provide(NodePath.layer),
              Effect.provide(NodeCrypto.layer),
            ),
          ),
        );
        if (registration === undefined) throw new Error("service registration missing");
        const serviceTokenRejected = yield* Effect.promise(
          () =>
            new Promise<boolean>((resolve) => {
              const socket = new WebSocket(view.url + "/rpc", {
                headers: { authorization: "Bearer " + registration.token },
              });
              socket.once("unexpected-response", (_request, response) => {
                resolve(response.statusCode === 401);
                socket.terminate();
              });
              socket.once("open", () => {
                resolve(false);
                socket.close();
              });
              socket.once("error", () => resolve(true));
            }),
        );
        expect(serviceTokenRejected).toBe(true);

        const readUrl = yield* call(root, (client) =>
          client.CreateArtifactUrl({
            projectId: added.summary.id,
            artifact: "dashboard",
            scope: "read",
            transparent: false,
          }),
        );
        if (readUrl._tag !== "created") throw new Error("expected a read URL");
        const readToken = tokenFromCopyUrl(readUrl.copyUrl);
        const metadataSocket = yield* openSocket(view.url, readToken, "/metadata");
        yield* Effect.addFinalizer(() => Effect.sync(() => metadataSocket.close()));
        metadataSocket.send(JSON.stringify({ _tag: "Request", id: 1, tag: "Params", payload: {}, headers: [] }));
        const paramsMessage = yield* waitForMessage(metadataSocket, (value) =>
          isRecord(value) && value["requestId"] === 1 && value["_tag"] === "Exit",
        );
        expect(isRecord(paramsMessage)).toBe(true);

        metadataSocket.send(JSON.stringify({ _tag: "Request", id: 10, tag: "SetParam", payload: { key: "greeting", value: "hi" }, headers: [] }));
        const readSetParam = yield* waitForMessage(metadataSocket, (value) =>
          isRecord(value) && value["requestId"] === 10 && value["_tag"] === "Exit",
        );
        if (!isRecord(readSetParam) || !isRecord(readSetParam["exit"])) {
          throw new Error("bad read SetParam response");
        }
        expect(readSetParam["exit"]["_tag"]).toBe("Failure");

        const readSocket = yield* openSocket(view.url, readToken);
        yield* Effect.addFinalizer(() => Effect.sync(() => readSocket.close()));
        readSocket.send(JSON.stringify({ _tag: "Request", id: 2, tag: "Increment", payload: { by: 1 }, headers: [] }));
        const forbidden = yield* waitForMessage(readSocket, (value) =>
          isRecord(value) && value["requestId"] === 2 && value["_tag"] === "Exit",
        );
        if (!isRecord(forbidden) || !isRecord(forbidden["exit"])) throw new Error("bad forbidden response");
        expect(forbidden["exit"]["_tag"]).toBe("Failure");

        const actionRequest = yield* call(root, (client) =>
          client.CreateArtifactUrl({
            projectId: added.summary.id,
            artifact: "dashboard",
            scope: "action",
            transparent: false,
          }),
        );
        if (actionRequest._tag !== "confirmation-required") {
          throw new Error("expected action confirmation");
        }
        const approved = yield* call(root, (client) =>
          client.ApproveArtifactUrl({ confirmationId: actionRequest.confirmation.id }),
        );
        const actionToken = tokenFromCopyUrl(approved.copyUrl);
        const actionMetadataSocket = yield* openSocket(view.url, actionToken, "/metadata");
        yield* Effect.addFinalizer(() => Effect.sync(() => actionMetadataSocket.close()));
        actionMetadataSocket.send(JSON.stringify({ _tag: "Request", id: 11, tag: "SetParam", payload: { key: "greeting", value: "hi" }, headers: [] }));
        const actionSetParam = yield* waitForMessage(actionMetadataSocket, (value) =>
          isRecord(value) && value["requestId"] === 11 && value["_tag"] === "Exit",
        );
        if (!isRecord(actionSetParam) || !isRecord(actionSetParam["exit"])) {
          throw new Error("bad action SetParam response");
        }
        expect(actionSetParam["exit"]["_tag"]).toBe("Success");
        actionMetadataSocket.send(JSON.stringify({ _tag: "Request", id: 12, tag: "Params", payload: null, headers: [] }));
        const updatedParams = yield* waitForMessage(actionMetadataSocket, (value) =>
          isRecord(value) && value["requestId"] === 12 && value["_tag"] === "Exit",
        );
        if (!isRecord(updatedParams) || !isRecord(updatedParams["exit"])) {
          throw new Error("bad Params response");
        }
        const paramList = updatedParams["exit"]["value"];
        if (!Array.isArray(paramList)) throw new Error("Params value was not an array");
        const greetingParam = paramList.find(
          (value) => isRecord(value) && value["key"] === "greeting",
        );
        expect(isRecord(greetingParam) ? greetingParam["value"] : undefined).toBe("hi");

        const actionSocket = yield* openSocket(view.url, actionToken);
        yield* Effect.addFinalizer(() => Effect.sync(() => actionSocket.close()));

        actionSocket.send(JSON.stringify({ _tag: "Request", id: 3, tag: "Increment", payload: { by: 2 }, headers: [] }));
        const incremented = yield* waitForMessage(actionSocket, (value) =>
          isRecord(value) && value["requestId"] === 3 && value["_tag"] === "Exit",
        );
        if (!isRecord(incremented) || !isRecord(incremented["exit"])) throw new Error("bad action response");
        expect(incremented["exit"]["_tag"]).toBe("Success");

        actionSocket.send(JSON.stringify({ _tag: "Request", id: 4, tag: "Snapshot", payload: null, headers: [] }));
        const snapshot = yield* waitForMessage(actionSocket, (value) =>
          isRecord(value) && value["requestId"] === 4 && value["_tag"] === "Exit",
        );
        if (!isRecord(snapshot) || !isRecord(snapshot["exit"])) throw new Error("bad snapshot response");
        expect(snapshot["exit"]["_tag"]).toBe("Success");
        expect(isRecord(snapshot["exit"]["value"]) ? snapshot["exit"]["value"]["count"] : undefined).toBe(2);

        actionSocket.send(JSON.stringify({ _tag: "Request", id: 5, tag: "Counts", payload: null, headers: [] }));
        const chunks: Array<unknown> = [];
        while (chunks.length < 3) {
          const message = yield* waitForMessage(actionSocket, (value) =>
            isRecord(value) && value["requestId"] === 5 && value["_tag"] === "Chunk",
          );
          if (isRecord(message) && Array.isArray(message["values"])) chunks.push(...message["values"]);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(3);
        yield* waitForMessage(actionSocket, (value) =>
          isRecord(value) && value["requestId"] === 5 && value["_tag"] === "Exit",
        );

        const projectGeneration = (token: string): Effect.Effect<number, Error> =>
          Effect.gen(function* () {
            const socket = yield* openSocket(view.url, token, "/metadata");
            socket.send(JSON.stringify({ _tag: "Request", id: 9, tag: "Project", payload: null, headers: [] }));
            const message = yield* waitForMessage(socket, (value) =>
              isRecord(value) && value["requestId"] === 9 && value["_tag"] === "Exit",
            );
            socket.close();
            if (!isRecord(message) || !isRecord(message["exit"])) {
              return yield* Effect.fail(new Error("bad Project response"));
            }
            const value = message["exit"]["value"];
            if (!isRecord(value) || typeof value["generation"] !== "number") {
              return yield* Effect.fail(new Error("Project had no generation"));
            }
            return value["generation"];
          });

        const generationBefore = yield* projectGeneration(actionToken);
        yield* Effect.promise(() =>
          writeFile(
            join(project, "artifacts", "dashboard", "main.ts"),
            artifactSource + 'document.title = "dashboard-v2";\n',
            "utf8",
          ),
        );
        yield* waitFor("rebuilt artifact", () =>
          Effect.promise(async () => {
            const response = await fetch(new URL("main.js", view.pageUrl));
            if (!response.ok) return undefined;
            const text = await response.text();
            return text.includes("dashboard-v2") ? text : undefined;
          }),
        );
        const generationAfter = yield* projectGeneration(actionToken);
        expect(generationAfter).toBe(generationBefore);

        // The counter survives a service restart.
        yield* service.stop();
        const restarted = yield* startService(root);
        yield* Effect.addFinalizer(() => restarted.stop());
        yield* waitFor("restarted project", () =>
          call(root, (client) => client.GetProject({ projectId: added.summary.id })).pipe(
            Effect.map((detail) => (detail.summary.status === "running" ? detail : undefined)),
          ),
        );
        const restartedView = yield* call(root, (client) =>
          client.GetArtifactView({ projectId: added.summary.id, artifact: "dashboard" }),
        );
        const restartedSocket = yield* openSocket(restartedView.url, actionToken);
        yield* Effect.addFinalizer(() => Effect.sync(() => restartedSocket.close()));
        restartedSocket.send(JSON.stringify({ _tag: "Request", id: 6, tag: "Snapshot", payload: null, headers: [] }));
        const persisted = yield* waitForMessage(restartedSocket, (value) =>
          isRecord(value) && value["requestId"] === 6 && value["_tag"] === "Exit",
        );
        if (!isRecord(persisted) || !isRecord(persisted["exit"])) throw new Error("bad persisted snapshot");
        expect(persisted["exit"]["_tag"]).toBe("Success");
        expect(
          isRecord(persisted["exit"]["value"]) ? persisted["exit"]["value"]["count"] : undefined,
        ).toBe(2);

        // Revocation is immediate for new connections.
        yield* call(root, (client) => client.RevokeArtifactUrl({ id: readUrl.url.id }));
        const revoked = yield* Effect.promise(
          () =>
            new Promise<boolean>((resolve) => {
              const socket = new WebSocket(view.url + "/rpc?token=" + readToken);
              socket.once("unexpected-response", (_request, response) => {
                resolve(response.statusCode === 401);
                socket.terminate();
              });
              socket.once("open", () => {
                resolve(false);
                socket.close();
              });
              socket.once("error", () => resolve(true));
            }),
        );
        expect(revoked).toBe(true);
      }),
    120_000,
  );
});
