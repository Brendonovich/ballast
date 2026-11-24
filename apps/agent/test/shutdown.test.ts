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
import { startMockObsServer } from "./mock-obs-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const projectSource = [
  'import * as Ballast from "@ballast/core";',
  'import * as OBS from "@ballast/module-obs";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const obs = yield* OBS.Connection("main");',
  '  yield* OBS.CurrentProgramSceneChanged.subscribe("scene", obs, () => Effect.void);',
  '  yield* Ballast.Artifact("dashboard", {',
  '    title: "Dashboard",',
  '    entry: "./artifacts/dashboard/main.ts",',
  "  });",
  "});",
  "",
].join("\n");

const artifactSource = [
  'const root = document.getElementById("root");',
  'if (root !== null) root.textContent = "shutdown";',
  "",
].join("\n");

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
    Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
  );

const waitForService = (root: string, child: ChildProcess): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
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
      if (registration?.pid === child.pid) return true;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("service did not start"));
  });

const waitForRunning = (root: string, projectId: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 800; attempt += 1) {
      yield* call(root, (client) => client.StartProject({ projectId })).pipe(
        Effect.catch(() => Effect.void),
      );
      const detail = yield* call(root, (client) => client.GetProject({ projectId }));
      if (detail.summary.status === "running") return;
      const consents = yield* call(root, (client) =>
        client.ListProjectConsents({ projectId }),
      );
      for (const consent of consents.consents) {
        yield* call(root, (client) => client.ApproveProjectConsent({ consentId: consent.id }));
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("project did not start"));
  });

describe("service shutdown", () => {
  it.live(
    "exits within the bound with a running project, OBS reconnect and a gateway socket",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-shutdown-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(join(project, "src"), { recursive: true }));
        yield* Effect.promise(() =>
          mkdir(join(project, "artifacts", "dashboard"), { recursive: true }),
        );
        yield* Effect.promise(() => writeFile(join(project, "ballast.ts"), projectSource, "utf8"));
        yield* Effect.promise(() =>
          writeFile(join(project, "artifacts", "dashboard", "main.ts"), artifactSource, "utf8"),
        );

        const obs = yield* Effect.promise(() => startMockObsServer());
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
        child.stdout?.on("data", () => {});
        child.stderr?.on("data", () => {});
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }),
        );

        yield* waitForService(root, child);

        const connection = yield* call(root, (client) =>
          client.CreateConnection({
            integration: "obs",
            label: "Shutdown OBS",
            config: { url: obs.url },
          }),
        );
        const added = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Shutdown" }),
        );
        const addError = added.summary.issues.find(
          (issue) => issue.severity === "error",
        );
        if (addError !== undefined) {
          return yield* Effect.fail(new Error(addError.detail ?? addError.title));
        }
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId: added.summary.id,
            integration: "obs",
            slot: "main",
            instanceId: connection.id,
          }),
        );
        yield* waitForRunning(root, added.summary.id);

        // A generation swap leaves the old worker in the 30s grace window.
        yield* call(root, (client) => client.RestartProject({ projectId: added.summary.id }));
        yield* waitForRunning(root, added.summary.id);

        // Drop OBS so the driver is sleeping in reconnect backoff.
        yield* Effect.promise(() => obs.close());

        const view = yield* call(root, (client) =>
          client.GetArtifactView({
            projectId: added.summary.id,
            artifact: "dashboard",
          }),
        );
        const socket = yield* Effect.promise(
          () =>
            new Promise<WebSocket>((resolve, reject) => {
              const opened = new WebSocket(view.url + "/metadata?token=" + view.token);
              opened.once("open", () => resolve(opened));
              opened.once("error", reject);
            }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

        const startedAt = Date.now();
        child.kill("SIGTERM");
        while (
          Date.now() - startedAt < 5_000 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          yield* Effect.sleep("50 millis");
        }
        const elapsed = Date.now() - startedAt;
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        expect(elapsed).toBeLessThan(3_000);
      }),
    120_000,
  );
});
