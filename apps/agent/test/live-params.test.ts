import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const source = [
  'import * as Ballast from "@ballast/core";',
  'import * as Fake from "@ballast/fake";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const fake = yield* Fake.Connection("main");',
  '  const message = yield* Ballast.Param.string("message", { default: "one" });',
  "",
  '  yield* Fake.Tick.subscribe("tick", fake, () =>',
  "    Effect.gen(function* () {",
  '      yield* Effect.log("HANDLER " + (yield* message));',
  "    }),",
  "  );",
  "",
  '  yield* Ballast.run("loop", Effect.gen(function* () {',
  "    while (true) {",
  '      yield* Effect.log("LOOP " + (yield* message));',
  '      yield* Effect.sleep("300 millis");',
  "    }",
  "  }));",
  "}) satisfies Ballast.Project;",
  "",
].join("\n");

interface Service {
  readonly child: ChildProcess;
  readonly stop: () => Effect.Effect<void>;
}

const startService = (root: string): Effect.Effect<Service, Error> =>
  Effect.gen(function* () {
    const stateDir = join(root, "state");
    const dataDir = join(root, "data");
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "serve", "--port", "0"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          BALLAST_STATE_DIR: stateDir,
          BALLAST_DATA_DIR: dataDir,
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
          readServiceRegistration(stateDir).pipe(
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

const waitForLog = (
  root: string,
  projectId: string,
  text: string,
): Effect.Effect<void, Error> =>
  call(root, (client) =>
    client.StreamLogs({ projectId }).pipe(
      Stream.filter((entry) => entry.message.includes(text)),
      Stream.take(1),
      Stream.runCollect,
    ),
  ).pipe(
    Effect.timeout("20 seconds"),
    Effect.asVoid,
    Effect.mapError(asError),
  );

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

describe("live project params", () => {
  it.live(
    "updates running handlers and run loops without restarting the worker",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-live-params-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );
        const project = join(root, "project");
        yield* Effect.promise(() => mkdir(project, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(project, "ballast.ts"), source, "utf8"));

        const service = yield* startService(root);
        yield* Effect.addFinalizer(() => service.stop());

        const connection = yield* call(root, (client) =>
          client.CreateConnection({ integration: "fake", label: "Fake", config: {} }),
        );
        const detail = yield* call(root, (client) =>
          client.AddProject({ path: project, name: "Live params" }),
        );
        const projectId = detail.summary.id;
        yield* call(root, (client) =>
          client.SetProjectBinding({
            projectId,
            integration: "fake",
            slot: "main",
            instanceId: connection.id,
          }),
        );
        yield* startProject(root, projectId);

        yield* waitForLog(root, projectId, "HANDLER one");
        yield* waitForLog(root, projectId, "LOOP one");

        const updated = yield* call(root, (client) =>
          client.SetProjectParam({ projectId, key: "message", value: "two" }),
        );
        expect(updated.manifest.params.find((param) => param.key === "message")?.value).toBe("two");

        yield* waitForLog(root, projectId, "HANDLER two");
        yield* waitForLog(root, projectId, "LOOP two");
        const paramLogs = yield* call(root, (client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message === "param message updated"),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("20 seconds"), Effect.mapError(asError));
        expect(paramLogs[0]?.unitKind).toBe("param");
        expect(paramLogs[0]?.unitName).toBe("message");

        const secondStart = yield* call(root, (client) =>
          client.StreamLogs({ projectId }).pipe(
            Stream.filter((entry) => entry.message.includes("started project generation")),
            Stream.take(2),
            Stream.runCollect,
          ),
        ).pipe(Effect.timeout("2 seconds"), Effect.exit);
        expect(secondStart._tag).toBe("Failure");
      }),
    120_000,
  );
});
