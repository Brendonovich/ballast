import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { SourceMapGenerator } from "source-map-js";
import type { Manifest } from "@ballast/core";
import { mapManifestSources } from "../src/source-map.ts";

describe("mapManifestSources", () => {
  it("normalizes a source whose parent-relative suffix resolves into the project", async () => {
    const base = await mkdtemp(join(tmpdir(), "ballast-map-"));
    const root = join(base, "projects", "demo");
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "export {};\n", "utf8");
      const bundle = join(base, "script.mjs");
      const generator = new SourceMapGenerator({ file: "script.mjs" });
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 3, column: 4 },
        source: "../../../../projects/demo/src/a.ts",
      });
      const mapPath = bundle + ".map";
      await writeFile(mapPath, generator.toString(), "utf8");

      const manifest: Manifest = {
        project: { id: "demo", entry: "ballast.ts" },
        params: [],
        connections: [],
        topics: [],
        requests: [],
        unresolved: [],
        timers: [],
        workflows: [],
        runs: [{ name: "loop", source: { file: bundle, line: 1, column: 1 } }],
        artifacts: [],
        stores: [],
        databases: [{ name: "main", source: { file: bundle, line: 1, column: 1 } }],
      };

      const mapped = mapManifestSources(manifest, mapPath, bundle, root);
      expect(mapped.runs[0]?.source).toEqual({ file: "src/a.ts", line: 3, column: 5 });
      expect(mapped.databases[0]?.source).toEqual({ file: "src/a.ts", line: 3, column: 5 });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
