import { mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
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
        expect(project.manifest.project.entry).toBe("ballast.ts");
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );

  it.live(
    "repoints types/current when the service version changes",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-types-version-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );
        const dataDir = join(root, "data");

        const first = yield* ensureProjectTypes({ dataDir, version: "0.1.0-one" });
        expect(first).toBe(join(dataDir, "types", "current"));
        expect(yield* Effect.promise(() => readlink(first))).toContain("0-1-0-one");

        const second = yield* ensureProjectTypes({ dataDir, version: "0.1.0-two" });
        expect(second).toBe(first);
        expect(yield* Effect.promise(() => readlink(first))).toContain("0-1-0-two");
        expect(yield* Effect.promise(() => readlink(join(dataDir, "types", "0-1-0-two")))).toContain("node_modules");
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});
