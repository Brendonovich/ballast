import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  withAgentClient(use, { BALLAST_STATE_DIR: join(root, "state"), BALLAST_DATA_DIR: join(root, "data") }).pipe(
    Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
    Effect.mapError(asError));

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
        BALLAST_ARTIFACT_PORT: "0",
        BALLAST_PROJECTS_DIR: join(root, "projects"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    yield* waitFor("service", () =>
      Effect.promise(async () => {
        const registration = await Effect.runPromise(readServiceRegistration(join(root, "state")).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)));
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
      const tsconfig = JSON.parse(
        yield* Effect.promise(() => readFile(join(projectRoot, "tsconfig.json"), "utf8")),
      ) as {
        compilerOptions: {
          paths: Record<string, ReadonlyArray<string>>;
          typeRoots: ReadonlyArray<string>;
        };
      };
      expect(tsconfig.compilerOptions.paths["@ballast/*"]?.[0]).toContain(
        "/types/current/@ballast/*/src/index.ts",
      );
      expect(tsconfig.compilerOptions.typeRoots[0]).toContain("/types/current/@types");

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
      expect(needsConsent.summary.status).toBe("needs-user");
      expect(needsConsent.missingScopes).toContain("fake:read");
      expect(needsConsent.changes.some((change) => change.kind === "topic" && change.change === "added")).toBe(true);
      expect(needsConsent.appliedManifest?.topics).toEqual([]);

      const planned = yield* call(root, (client) =>
        client.PlanProject({ projectId: created.summary.id }),
      );
      expect(planned.pendingConsent).toBeDefined();
      expect(planned.summary.status).toBe("needs-user");
      const health = yield* call(root, (client) => client.GetHealth());
      expect(health.projects.needsConsent).toBe(1);
      expect((yield* call(root, (client) => client.ListProjectConsents({ projectId: created.summary.id }))).consents).toHaveLength(1);

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

      const failedPlan = yield* call(root, (client) =>
        client.PlanProject({ projectId: created.summary.id }),
      ).pipe(Effect.exit);
      expect(failedPlan._tag).toBe("Failure");
      const withPlanError = yield* call(root, (client) =>
        client.GetProject({ projectId: created.summary.id }),
      );
      expect(
        withPlanError.summary.issues.some((issue) => issue.kind === "change-not-applied"),
      ).toBe(true);
      expect(withPlanError.summary.status).toBe("needs-user");

      yield* Effect.promise(() =>
        writeFile(
          join(projectRoot, "ballast.ts"),
          'import { Effect } from "effect";\n\nexport default Effect.gen(function* () {\n  yield* Effect.log("ok");\n});\n',
          "utf8",
        ),
      );
      const repaired = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(repaired.ok).toBe(true);
      expect(
        repaired.summary.issues.some((issue) => issue.kind === "change-not-applied"),
      ).toBe(false);
      expect(repaired.summary.status).toBe("needs-user");
    }),
    120_000,
  );

  it.live("scaffolds the Solid artifact template and typechecks it", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-artifact-scaffold-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const created = yield* call(root, (client) =>
        client.CreateProject({ name: "Artifact Template", artifact: true }),
      );
      const projectRoot = join(root, "projects", "artifact-template");
      expect(
        (yield* Effect.promise(() => stat(join(projectRoot, "artifacts", "dashboard", "main.tsx")))).isFile(),
      ).toBe(true);
      expect(
        (yield* Effect.promise(() => stat(join(projectRoot, "src", "api.ts")))).isFile(),
      ).toBe(true);

      const artifactsConfig = yield* Effect.promise(() =>
        readFile(join(projectRoot, "artifacts", "tsconfig.json"), "utf8"),
      );
      expect(artifactsConfig).toContain('"jsx": "preserve"');
      expect(artifactsConfig).toContain('"jsxImportSource": "@solidjs/web"');
      expect(artifactsConfig).toContain('"DOM"');
      expect(artifactsConfig).toContain('"@solidjs/web"');
      expect(artifactsConfig).not.toContain('"../src/**/*.ts"');
      expect(artifactsConfig).toContain("generated by ballast; edits are kept");
      const rootConfig = yield* Effect.promise(() =>
        readFile(join(projectRoot, "tsconfig.json"), "utf8"),
      );
      expect(rootConfig).toContain('"artifacts"');
      expect(rootConfig).toContain("generated by ballast; edits are kept");
      expect(rootConfig).toContain("@ballast/artifact/protocol");
      expect(rootConfig).toContain("@ballast/artifact/solid");
      expect(rootConfig).toContain("@solidjs/web");

      const check = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(check.ok).toBe(true);
      expect((check.manifest?.artifacts ?? []).some((artifact) => artifact.name === "dashboard")).toBe(true);

      const artifactFile = join(projectRoot, "artifacts", "dashboard", "main.tsx");
      const artifactSource = yield* Effect.promise(() => readFile(artifactFile, "utf8"));
      yield* Effect.promise(() =>
        writeFile(artifactFile, artifactSource + '\nconst brokenArtifact: number = "nope";\n', "utf8"),
      );
      const broken = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(broken.ok).toBe(false);
      expect(
        broken.diagnostics.some(
          (diagnostic) =>
            diagnostic.file === "artifacts/dashboard/main.tsx" &&
            diagnostic.code === "TS2322",
        ),
      ).toBe(true);

      yield* Effect.promise(() =>
        writeFile(artifactFile, artifactSource, "utf8"),
      );
      const userEdited = artifactsConfig + "// user edit\n";
      yield* Effect.promise(() =>
        writeFile(join(projectRoot, "artifacts", "tsconfig.json"), userEdited, "utf8"),
      );
      const afterEdit = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(afterEdit.ok).toBe(true);
      expect(
        afterEdit.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "TS_CONFIG_STALE" &&
            diagnostic.file === "artifacts/tsconfig.json",
        ),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          readFile(join(projectRoot, "artifacts", "tsconfig.json"), "utf8"),
        ),
      ).toBe(userEdited);

      const staleConfig = {
        extends: "../tsconfig.json",
        compilerOptions: {
          lib: ["ES2024", "DOM", "DOM.Iterable"],
          jsx: "preserve",
          jsxImportSource: "solid-js",
          types: [],
          noEmit: true,
          composite: false,
          declaration: false,
          declarationMap: false,
          emitDeclarationOnly: false,
          sourceMap: false,
          incremental: false,
        },
        include: ["**/*.ts", "**/*.tsx", "../src/**/*.ts"],
        exclude: ["../node_modules", "../dist", "../.ballast"],
      };
      yield* Effect.promise(() =>
        writeFile(
          join(projectRoot, "artifacts", "tsconfig.json"),
          JSON.stringify(staleConfig, null, 2) + "\n",
          "utf8",
        ),
      );
      const afterStale = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(afterStale.ok).toBe(true);
      const regenerated = yield* Effect.promise(() =>
        readFile(join(projectRoot, "artifacts", "tsconfig.json"), "utf8"),
      );
      expect(regenerated).not.toContain('"../src/**/*.ts"');
      expect(regenerated).toContain("generated by ballast; edits are kept");

      yield* Effect.promise(() =>
        rm(join(projectRoot, "artifacts", "tsconfig.json"), { force: true }),
      );
      const afterDelete = yield* call(root, (client) =>
        client.CheckProject({ projectId: created.summary.id }),
      );
      expect(afterDelete.ok).toBe(true);
      const recreated = yield* Effect.promise(() =>
        readFile(join(projectRoot, "artifacts", "tsconfig.json"), "utf8"),
      );
      expect(recreated).toContain('"extends": "../tsconfig.json"');
      expect(recreated).not.toContain('"../src/**/*.ts"');
    }),
    120_000,
  );

  it.live("loads old applied manifests with additive defaults and quarantines invalid ones", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-applied-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      const entry = 'import { Effect } from "effect";\n\nexport default Effect.gen(function* () {\n  yield* Effect.void;\n});\n';
      const legacy = join(root, "legacy-project");
      yield* Effect.promise(() => mkdir(join(legacy, ".ballast"), { recursive: true }));
      yield* Effect.promise(() => writeFile(join(legacy, "ballast.ts"), entry, "utf8"));
      yield* Effect.promise(() =>
        writeFile(
          join(legacy, ".ballast", "applied.json"),
          JSON.stringify({
            version: 1,
            appliedAt: 123,
            manifest: {
              project: { id: "legacy", entry: "ballast.ts" },
              params: [],
              connections: [],
              topics: [],
              requests: [],
              unresolved: [],
              timers: [],
              workflows: [],
              runs: [],
            },
          }),
          "utf8",
        ),
      );

      const loaded = yield* call(root, (client) => client.AddProject({ path: legacy, name: "Legacy" }));
      expect(loaded.summary.status).not.toBe("error");
      expect(loaded.manifest.artifacts).toEqual([]);
      expect(loaded.manifest.databases).toEqual([]);
      expect(loaded.manifest.stores).toEqual([]);
      const migrated = yield* Effect.promise(() => readFile(join(legacy, ".ballast", "applied.json"), "utf8"));
      expect(migrated).toContain('"artifacts"');
      expect(migrated).toContain('"databases"');

      const invalid = join(root, "invalid-project");
      yield* Effect.promise(() => mkdir(join(invalid, ".ballast"), { recursive: true }));
      yield* Effect.promise(() => writeFile(join(invalid, "ballast.ts"), entry, "utf8"));
      yield* Effect.promise(() =>
        writeFile(
          join(invalid, ".ballast", "applied.json"),
          JSON.stringify({ version: 1, manifest: { project: { id: "invalid", entry: "ballast.ts" }, params: "nope" } }),
          "utf8",
        ),
      );
      const quarantined = yield* call(root, (client) => client.AddProject({ path: invalid, name: "Invalid" }));
      expect(quarantined.summary.status).not.toBe("error");
      const files = yield* Effect.promise(() => readdir(join(invalid, ".ballast")));
      expect(files.some((file) => file.startsWith("applied.json.corrupt-"))).toBe(true);
      const warning = yield* call(root, (client) =>
        client.StreamLogs({ projectId: quarantined.summary.id, limit: 100 }).pipe(
          Stream.filter((line) => line.message.includes("applied.json")),
          Stream.take(1),
          Stream.runCollect,
        ),
      ).pipe(Effect.timeout("10 seconds"));
      expect(Array.from(warning).some((line) => line.message.includes("manifest is missing") || line.message.includes("invalid"))).toBe(true);
    }),
    120_000,
  );

  it.live("prepares the shared type root on startup and whenever a project is added or planned", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-types-lifecycle-")));
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore));
      const typesCurrent = join(root, "data", "types", "current");

      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());

      // Startup prepares the root even before any project exists.
      expect(yield* Effect.promise(() => readlink(typesCurrent))).toContain("/types/");

      const projectRoot = join(root, "added-project");
      yield* Effect.promise(() => mkdir(projectRoot, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(
          join(projectRoot, "ballast.ts"),
          'import { Effect } from "effect";\n\nexport default Effect.gen(function* () {\n  yield* Effect.log("ready");\n});\n',
          "utf8",
        ),
      );

      // An added project whose tsconfig outlived the type root recreates it.
      yield* Effect.promise(() => rm(join(root, "data", "types"), { recursive: true, force: true }));
      const added = yield* call(root, (client) => client.AddProject({ path: projectRoot, name: "Added" }));
      expect(yield* Effect.promise(() => readlink(typesCurrent))).toContain("/types/");

      // Planning and checking do the same before they run tsgo.
      yield* Effect.promise(() => rm(join(root, "data", "types"), { recursive: true, force: true }));
      yield* call(root, (client) => client.PlanProject({ projectId: added.summary.id }));
      expect(yield* Effect.promise(() => readlink(typesCurrent))).toContain("/types/");

      yield* Effect.promise(() => rm(join(root, "data", "types"), { recursive: true, force: true }));
      const checked = yield* call(root, (client) => client.CheckProject({ projectId: added.summary.id }));
      expect(checked.ok, checked.error).toBe(true);
      expect(yield* Effect.promise(() => readlink(typesCurrent))).toContain("/types/");
    }),
    120_000,
  );
});
