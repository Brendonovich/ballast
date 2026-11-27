import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  plan,
  planDetails,
  planProject,
  resolveProjectEntry,
  PlanError,
  ProjectPlanError,
} from "../src/index.ts";

const example = fileURLToPath(new URL("../../../examples/tick-echo.ts", import.meta.url));
const callRequest = fileURLToPath(
  new URL("./fixtures/call-request.ts", import.meta.url),
);
const untitled = fileURLToPath(new URL("./fixtures/tick-echo.ts", import.meta.url));
const artifactUrl = fileURLToPath(
  new URL("./fixtures/artifact-url.ts", import.meta.url),
);
const takeover = fileURLToPath(new URL("../../../examples/redeem-takeover.ts", import.meta.url));
const project = fileURLToPath(new URL("./fixtures/project/ballast.ts", import.meta.url));
const duplicateProject = fileURLToPath(
  new URL("./fixtures/duplicate/ballast.ts", import.meta.url),
);

describe("plan", () => {
  it.effect("produces the tick-echo manifest", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        project: { id: "tick-echo", entry: "tick-echo.ts" },
        params: [{ key: "prefix", type: "string", title: "Prefix", default: ">" }],
        connections: [{ integration: "fake", slot: "main", location: "local" }],
        topics: [
          {
            integration: "fake",
            slot: "main",
            topic: "fake/tick",
            name: "tick",
            scopes: ["fake:read"],
            onStale: "drop",
            maxAgeMs: 60_000,
            history: false,
            schemaFingerprint: expect.any(String),
          },
        ],
        requests: [
          {
            integration: "fake",
            slot: "main",
            request: "fake/*",
            scopes: [],
          },
        ],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [],
        artifacts: [],
        stores: [],
        databases: [],
      });
    }),
  );

  it.effect("injects the artifact host into the handle URL getter", () =>
    Effect.gen(function* () {
      const withoutHost = yield* plan(artifactUrl);
      expect(withoutHost.params).toEqual([
        {
          key: "overlayUrl",
          type: "string",
          default: expect.stringContaining("unresolved"),
        },
      ]);
      expect(withoutHost.unresolved).toEqual([
        expect.objectContaining({ path: "artifact:overlay" }),
      ]);

      const withHost = yield* plan(artifactUrl, {
        artifactHost: { origin: "http://127.0.0.1:47831", readToken: "r1.overlay.test" },
      });
      expect(withHost.params).toEqual([
        {
          key: "overlayUrl",
          type: "string",
          default:
            "http://127.0.0.1:47831/a/r1.overlay.test/overlay/index.html?background=transparent",
        },
      ]);
      expect(withHost.unresolved).toEqual([]);
    }),
  );

  it.effect("reads the optional title export", () =>
    Effect.gen(function* () {
      const result = yield* planDetails(example);
      expect(result.title).toBe("Tick Echo");
      expect(result.manifest.project.id).toBe("tick-echo");
    }),
  );

  it.effect("strips a script extension from the fallback title", () =>
    Effect.gen(function* () {
      const result = yield* planDetails(untitled);
      expect(result.title).toBe("Tick Echo");
    }),
  );

  it.effect("records a workflow declaration and its Twitch scope", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(takeover, {
        projectRoot: fileURLToPath(new URL("../../../examples", import.meta.url)),
      });

      expect(manifest.workflows.map((workflow) => workflow.name)).toEqual([
        "redeem-takeover",
      ]);
      expect(manifest.workflows[0]?.source?.file).toContain("redeem-takeover.ts");
      expect(
        manifest.requests.find((request) => request.request === "helix/updateRedemptionStatus")
          ?.scopes,
      ).toEqual(["channel:manage:redemptions"]);
    }),
  );

  it.effect("maps a named subscription to its imported source file", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(project, {
        projectRoot: fileURLToPath(new URL("./fixtures/project", import.meta.url)),
      });
      const topic = manifest.topics[0];

      expect(topic?.name).toBe("named-tick");
      expect(topic?.source?.file).toBe("src/a.ts");
      expect(topic?.source?.line).toBe(48);
      expect(topic?.source?.column).toBeGreaterThan(0);
      expect(manifest.params[0]?.source?.file).toBe("src/a.ts");
      expect(manifest.timers[0]?.source?.file).toBe("src/a.ts");
      expect(manifest.runs[0]?.source?.file).toBe("src/a.ts");
      expect(manifest.workflows[0]?.name).toBe("fixture-workflow");
      expect(manifest.workflows[0]?.source?.file).toBe("src/a.ts");
    }),
  );

  it.effect("rejects duplicate subscription names with both source locations", () =>
    Effect.gen(function* () {
      const error = yield* plan(duplicateProject, {
        projectRoot: fileURLToPath(new URL("./fixtures/duplicate", import.meta.url)),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(PlanError);
      expect(error.message).toContain("Duplicate subscription name \"same-name\"");
      expect(error.message).toContain("src/a.ts");
      expect(error.message).toContain("src/b.ts");
    }),
  );

  it.effect("typechecks a project and reports file/line errors", () =>
    Effect.gen(function* () {
      const error = yield* planProject(
        fileURLToPath(new URL("./fixtures/type-error", import.meta.url)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectPlanError);
      if (!(error instanceof ProjectPlanError)) return;
      expect(error.message).toContain("ballast.ts:3:");
      expect(error.diagnostics[0]?.file).toBe("ballast.ts");
      expect(error.diagnostics[0]?.line).toBe(3);
    }),
  );

  it.effect("keeps source paths project-relative outside the repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-outside-")));
      yield* Effect.promise(() =>
        cp(fileURLToPath(new URL("./fixtures/project", import.meta.url)), root, {
          recursive: true,
        }),
      );
      const project = yield* planProject(root);
      expect(project.manifest.topics[0]?.source?.file).toBe("src/a.ts");
      expect(project.manifest.params[0]?.source?.file).toBe("src/a.ts");
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }),
  );

  it.effect("plans a whole project through the entry file", () =>
    Effect.gen(function* () {
      const project = yield* planProject(
        fileURLToPath(new URL("./fixtures/project", import.meta.url)),
      );

      expect(project.entry.entry).toBe("ballast.ts");
      expect(project.manifest.topics[0]?.name).toBe("named-tick");
      expect(project.manifest.topics[0]?.source?.file).toBe("src/a.ts");
    }),
  );

  it.effect("resolves the package.json entry override", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-entry-")));
      yield* Effect.promise(() =>
        writeFile(
          join(root, "package.json"),
          JSON.stringify({ ballast: { entry: "main.ts" } }),
          "utf8",
        ),
      );
      yield* Effect.promise(() => writeFile(join(root, "main.ts"), "export default 1;\n", "utf8"));

      const resolved = yield* resolveProjectEntry(root);

      expect(resolved.entry).toBe("main.ts");
      expect(resolved.entryFile).toBe(join(root, "main.ts"));
    }),
  );

  it.effect("plans a strings param backed by OBS scenes", () =>
    Effect.gen(function* () {
      const project = yield* planProject(
        fileURLToPath(new URL("../../../examples/param-strings-project", import.meta.url)),
      );
      const param = project.manifest.params.find((value) => value.key === "scenes");

      expect(param?.type).toBe("strings");
      expect(param?.default).toEqual(["Scene 1"]);
      expect(param?.options).toEqual({
        integration: "obs",
        slot: "main",
        source: "scenes",
      });
      expect(param?.description).toBe("Pick one or more OBS scenes");
    }),
  );

  it.effect("records the runtime default for params that always have a value", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-param-defaults-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "ballast.ts"),
          [
            'import * as Ballast from "@ballast/core";',
            'import { Effect } from "effect";',
            "",
            "export default Effect.gen(function* () {",
            '  yield* Ballast.Param.strings("scenes");',
            '  yield* Ballast.Param.boolean("enabled");',
            '  yield* Ballast.Param.enum("mode", ["a", "b"]);',
            '  yield* Ballast.Param.string("name");',
            '  yield* Ballast.Param.number("count");',
            "});",
            "",
          ].join("\n"),
          "utf8",
        ),
      );

      const planned = yield* planProject(root);
      const params = new Map(planned.manifest.params.map((param) => [param.key, param]));
      expect(params.get("scenes")?.default).toEqual([]);
      expect(params.get("enabled")?.default).toBe(false);
      expect(params.get("mode")?.default).toBe("a");
      // Text and number inputs can be left blank, so no default still means
      // required and no implicit manifest value.
      expect(params.get("name")?.default).toBeUndefined();
      expect(params.get("count")?.default).toBeUndefined();
    }),
  );

  it.effect("rejects a runtime read in init with the entry and a clear message", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-init-runtime-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "ballast.ts"),
          [
            'import * as Ballast from "@ballast/core";',
            'import { Effect } from "effect";',
            "",
            "export default Effect.gen(function* () {",
            '  const greeting = yield* Ballast.Param.string("greeting");',
            "  yield* Effect.log(yield* greeting);",
            "});",
            "",
          ].join("\n"),
          "utf8",
        ),
      );

      const error = yield* planProject(root).pipe(Effect.flip);
      expect(error.message).toContain("ballast.ts:5:");
      expect(error.message).toContain('Param "greeting" was read during init');
      expect(error.message).toContain("inside handlers/runs");
    }),
  );

  it.effect("rejects a database read in init as a runtime value", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-init-db-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "ballast.ts"),
          [
            'import * as Ballast from "@ballast/core";',
            'import { Effect } from "effect";',
            "",
            "export default Effect.gen(function* () {",
            '  const db = yield* Ballast.Database("main");',
            "  yield* Effect.log(yield* db.client);",
            "});",
            "",
          ].join("\n"),
          "utf8",
        ),
      );

      const error = yield* planProject(root).pipe(Effect.flip);
      expect(error.message).toContain("DatabaseCalledDuringPlanError");
      expect(error.message).toContain('Database "main" was read during plan');
      expect(error.message).not.toContain("TS_INIT_RUNTIME");
    }),
  );

  it.effect("prefers the declaration location over the Project satisfies location", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-init-project-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(root, "ballast.ts"),
          [
            'import * as Ballast from "@ballast/core";',
            'import { Effect } from "effect";',
            "",
            "export default Effect.gen(function* () {",
            '  const greeting = yield* Ballast.Param.string("greeting");',
            "  yield* Effect.log(yield* greeting);",
            "}) satisfies Ballast.Project;",
            "",
          ].join("\n"),
          "utf8",
        ),
      );

      const error = yield* planProject(root).pipe(Effect.flip);
      expect(error.message).toContain("ballast.ts:5:");
      expect(error.message).toContain('Param "greeting" was read during init');
    }),
  );

  it.effect("names the declaration when a single-file plan reads a param in init", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-init-plan-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      const file = join(root, "ballast.ts");
      yield* Effect.promise(() =>
        writeFile(
          file,
          [
            'import * as Ballast from "@ballast/core";',
            'import { Effect } from "effect";',
            "",
            "export default Effect.gen(function* () {",
            '  const greeting = yield* Ballast.Param.string("greeting");',
            "  yield* Effect.log(yield* greeting);",
            "});",
            "",
          ].join("\n"),
          "utf8",
        ),
      );

      const error = yield* plan(file).pipe(Effect.flip);
      expect(error.message).toContain('Param "greeting" was read during init at ballast.ts:');
      expect(error.message).toContain("Read params inside handlers/runs, not in init");
    }),
  );

  it.effect("plans and bundles a Solid artifact with stores and an API", () =>
    Effect.gen(function* () {
      const project = yield* planProject(
        fileURLToPath(new URL("../../../examples/stream-dashboard", import.meta.url)),
      );

      expect(project.manifest.artifacts.map((artifact) => artifact.name)).toEqual([
        "dashboard",
      ]);
      expect(project.manifest.artifacts[0]?.source?.file).toBe("ballast.ts");
      expect(project.manifest.api?.source?.file).toBe("ballast.ts");
      expect(project.manifest.stores[0]?.source?.file).toBe("ballast.ts");
      expect(
        project.manifest.api?.procedures.map(
          (procedure) => procedure.name + ":" + procedure.kind,
        ),
      ).toEqual(["Chat:stream", "ResetCounters:action", "Snapshot:query"]);
      expect(
        project.manifest.stores.map((store) => store.name + ":" + store.kind),
      ).toEqual(["messages:counter", "sceneSwitches:counter"]);
      expect(
        project.manifest.topics.find((topic) => topic.name === "chat-log")?.history,
      ).toEqual({ maxEntries: 500, retentionMs: 7 * 24 * 60 * 60_000 });
      expect(
        project.manifest.topics.find((topic) => topic.name === "scene-tick")?.history,
      ).toBe(false);
      expect(
        project.manifest.topics.find((topic) => topic.name === "chat-log")
          ?.schemaFingerprint,
      ).toMatch(/^[0-9a-f]{64}$/);

      const built = project.artifacts[0];
      expect(built?.name).toBe("dashboard");
      if (built === undefined) return;
      const javascript = yield* Effect.promise(() =>
        readFile(built.javascriptPath, "utf8"),
      );
      expect(javascript).toContain("reset");
      expect(built.htmlPath.endsWith("index.html")).toBe(true);
    }),
  );

  it.effect("bundles a copied artifact project with the CLI stage resolveDir", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "ballast-artifact-resolve-")),
      );
      const source = fileURLToPath(
        new URL("../../../examples/stream-dashboard", import.meta.url),
      );
      const resolveDir = fileURLToPath(new URL("../../../apps/agent", import.meta.url));
      yield* Effect.promise(() => cp(source, root, { recursive: true }));
      try {
        const project = yield* planProject(root, { resolveDir });
        expect(project.artifacts[0]?.bytes).toBeGreaterThan(0);
        const html = yield* Effect.promise(() =>
          readFile(join(root, ".ballast", "artifacts", "dashboard", "index.html"), "utf8"),
        );
        expect(html).toContain("bootstrap.js");
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
  );

  it.effect("locates a runtime read introduced by an init helper", () =>
    Effect.gen(function* () {
      const error = yield* planProject(
        fileURLToPath(new URL("./fixtures/runtime-helper", import.meta.url)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectPlanError);
      if (!(error instanceof ProjectPlanError)) return;
      expect(error.message).toContain('Param "prefix" was read during init');
      expect(error.message).toContain("helper.ts:6");
      expect(error.message).not.toContain("ballast.ts:");
    }),
  );

  it.effect("does not pull worker modules under src into the artifact project", () =>
    Effect.gen(function* () {
      const project = yield* planProject(
        fileURLToPath(new URL("./fixtures/artifact-worker-ok", import.meta.url)),
      );
      expect(project.artifacts.map((artifact) => artifact.name)).toEqual(["ok"]);
      expect(project.typecheck.filter((diagnostic) => diagnostic.kind !== "config")).toEqual([]);
    }),
  );

  it.effect("reports an artifact import of a worker-only module clearly", () =>
    Effect.gen(function* () {
      const error = yield* planProject(
        fileURLToPath(new URL("./fixtures/artifact-worker-import", import.meta.url)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectPlanError);
      if (!(error instanceof ProjectPlanError)) return;
      expect(error.message).toContain("artifact imports a worker-only module");
      expect(
        error.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("artifact imports a worker-only module"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("fails artifact typecheck with a file/line diagnostic", () =>
    Effect.gen(function* () {
      const error = yield* planProject(
        fileURLToPath(new URL("./fixtures/artifact-type-error", import.meta.url)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectPlanError);
      if (!(error instanceof ProjectPlanError)) return;
      expect(error.diagnostics[0]?.file).toBe("artifacts/bad/main.tsx");
      expect(error.diagnostics[0]?.kind).toBe("artifact");
      expect(error.diagnostics[0]?.line).toBe(1);
    }),
  );

  it.effect("rejects a second Api.serve", () =>
    Effect.gen(function* () {
      const error = yield* planProject(
        fileURLToPath(new URL("./fixtures/duplicate-api", import.meta.url)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectPlanError);
      if (!(error instanceof ProjectPlanError)) return;
      expect(error.message).toContain("Api.serve may be called once");
    }),
  );

  it.effect("records requests without calling them", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);
      const requests = manifest.requests.map((request) => request.request);
      expect(requests).toEqual(["fake/*"]);
    }),
  );

  it.effect("dies if init calls a request client", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PlanError);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
