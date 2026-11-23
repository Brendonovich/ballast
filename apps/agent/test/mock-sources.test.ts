import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { mockScriptSources } from "@ballast/agent-protocol";
import { plan, planProject } from "@ballast/planner";
import { ensureProjectTypes, scaffoldProject } from "../src/service/scaffold.ts";

describe("embedded script sources", () => {
  it.live(
    "plans every mock source and the scaffold template",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-embedded-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );

        for (const [id, source] of mockScriptSources) {
          const file = join(root, id.replaceAll("/", "-"));
          yield* Effect.promise(() => writeFile(file, source, "utf8"));
          const manifest = yield* plan(file);
          expect(manifest.project.entry).toBe(id.replaceAll("/", "-"));
          if (id === "scripts/redeem-to-scene.ts") {
            const scene = manifest.params.find((param) => param.key === "scene");
            expect(scene?.options).toEqual({
              integration: "obs",
              slot: "main",
              source: "scenes",
            });
          }
        }

        const typesDir = yield* ensureProjectTypes({
          dataDir: join(root, "data"),
          version: "test",
        });
        const scaffolded = yield* scaffoldProject({
          name: "Embedded Scaffold",
          directory: join(root, "scaffold"),
          typesDir,
        });
        const project = yield* planProject(scaffolded.root);
        const manifest = project.manifest;
        expect(manifest.project.entry).toBe("ballast.ts");
        expect(manifest.params.map((param) => param.key)).toEqual(["greeting"]);
        expect(manifest.runs.map((run) => run.name)).toEqual(["ready"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );
});
