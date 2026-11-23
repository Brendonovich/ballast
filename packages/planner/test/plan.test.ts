import { mkdtemp, writeFile } from "node:fs/promises";
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
          },
        ],
        requests: [
          {
            integration: "fake",
            slot: "main",
            request: "fake/echo",
            scopes: ["fake:write"],
          },
        ],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [],
      });
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
      expect(topic?.source?.line).toBe(47);
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

  it.effect("records requests without calling them", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);
      const requests = manifest.requests.map((request) => request.request);
      expect(requests).toEqual(["fake/echo"]);
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
