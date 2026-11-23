import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const waitFor = <A>(label: string, read: () => Effect.Effect<A | undefined>, timeoutMs = 30_000): Effect.Effect<A, Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* read();
      if (value !== undefined) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for " + label));
  });

const asError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return new Error(message);
    return new Error(JSON.stringify(error));
  }
  return new Error(String(error));
};

const call = <A, E>(root: string, use: (client: import("../src/service/client.ts").LiveAgentClient) => Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
  withAgentClient(use, { BALLAST_STATE_DIR: join(root, "state"), BALLAST_DATA_DIR: join(root, "data") }).pipe(Effect.mapError(asError));

interface Service {
  readonly child: ChildProcess;
  readonly stop: () => Effect.Effect<void>;
}

const startService = (root: string): Effect.Effect<Service, Error> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => rm(join(root, "state", "service.json"), { force: true }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "serve", "--port", "0"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: "1",
        BALLAST_STATE_DIR: join(root, "state"),
        BALLAST_DATA_DIR: join(root, "data"),
        BALLAST_LOG_DIR: join(root, "logs"),
        BALLAST_PROJECTS_DIR: join(root, "projects"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    yield* waitFor("service", () =>
      Effect.promise(async () => {
        const registration = await readServiceRegistration(join(root, "state"));
        return registration?.pid === child.pid ? registration : undefined;
      }),
    );
    const stop = () =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          yield* Effect.sleep("50 millis");
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        yield* Effect.sleep("100 millis");
      });
    return { child, stop };
  });

describe("project scaffolding and checks", () => {
  it.live("creates a project without overwriting and checks without applying", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-create-test-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const created = yield* call(root, (client) =>
        client.CreateProject({ name: "New Stream" }),
      );
      expect(created.summary.entry).toBe("ballast.ts");
      expect(created.summary.enabled).toBe(false);
      expect(created.summary.status).toBe("stopped");
      const projectRoot = join(root, "projects", "new-stream");
      expect((yield* Effect.promise(() => stat(join(projectRoot, "ballast.ts")))).isFile()).toBe(true);
      expect(yield* Effect.promise(() => readFile(join(projectRoot, "AGENTS.md"), "utf8"))).toContain("ballast_guide");
      expect(yield* Effect.promise(() => readFile(join(projectRoot, "package.json"), "utf8"))).toContain("ballast.ts");

      const duplicate = yield* call(root, (client) =>
        client.CreateProject({ name: "New Stream" }),
      ).pipe(Effect.exit);
      expect(duplicate._tag).toBe("Failure");

      const check = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(check.ok).toBe(true);
      expect(check.requiresConsent).toBe(false);
      expect(check.appliedManifest?.project.entry).toBe("ballast.ts");
      expect(check.units.some((unit) => unit.kind === "run" && unit.name === "ready")).toBe(true);

      const withScope = [
        'import * as Fake from "@ballast/fake";',
        'import { Effect } from "effect";',
        "",
        "export default Effect.gen(function* () {",
        '  const fake = yield* Fake.Connection("main");',
        '  yield* Fake.Tick.subscribe("tick", fake, () => Effect.void);',
        "});",
        "",
      ].join("\n");
      yield* Effect.promise(() => writeFile(join(projectRoot, "ballast.ts"), withScope, "utf8"));
      const needsConsent = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(needsConsent.requiresConsent).toBe(true);
      expect(needsConsent.missingScopes).toContain("fake:read");
      expect(needsConsent.changes.some((change) => change.kind === "topic" && change.change === "added")).toBe(true);
      expect(needsConsent.pendingConsent).toBeUndefined();
      expect(needsConsent.appliedManifest?.topics).toEqual([]);

      yield* Effect.promise(() =>
        writeFile(join(projectRoot, "ballast.ts"), "const broken: number = \"nope\";\n", "utf8"),
      );
      const broken = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(broken.ok).toBe(false);
      expect(broken.diagnostics[0]?.code).toBe("TS2322");
      expect(broken.diagnostics[0]?.file).toBe("ballast.ts");
      expect(broken.appliedManifest?.project.entry).toBe("ballast.ts");
    }),
    120_000,
  );
});
