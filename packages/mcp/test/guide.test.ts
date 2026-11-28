import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodePath } from "@effect/platform-node";
import { Effect } from "effect";
import { planProject } from "@ballast/planner";
import { afterEach, describe, expect, it } from "vitest";

import { GUIDE } from "../src/guide.ts";

const roots: Array<string> = [];
// Resolve guide imports the way the real agent does: its dependency set has
// @ballast/* and Solid 2, while packages/mcp itself has no Solid dependency.
const resolveRoot = fileURLToPath(new URL("../../../apps/agent", import.meta.url));

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface Sample {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

const samples = (): ReadonlyArray<Sample> => {
  const single: Array<Sample> = [];
  const groups = new Map<string, Record<string, string>>();
  const pattern = /```(ts|tsx)(?: sample="([^"]+)")? title="([^"]+)"\n([\s\S]*?)```/g;
  for (const match of GUIDE.matchAll(pattern)) {
    const sample = match[2];
    const title = match[3];
    const source = match[4];
    if (title === undefined || source === undefined) continue;
    if (sample === undefined) {
      single.push({ name: "single-" + single.length, files: { [title]: source } });
    } else {
      const files = groups.get(sample) ?? {};
      files[title] = source;
      groups.set(sample, files);
    }
  }
  return [...single, ...[...groups].map(([name, files]) => ({ name, files }))];
};

const writeSample = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, source, "utf8");
  }
};

describe("guide code samples", () => {
  it("typechecks, plans and builds every complete sample", async () => {
    const all = samples();
    expect(all.some((sample) => sample.name === "artifact")).toBe(true);
    for (const [index, sample] of all.entries()) {
      const root = await mkdtemp(join(tmpdir(), "ballast-guide-" + index + "-"));
      roots.push(root);
      await writeSample(root, sample.files);
      const planned = await Effect.runPromise(
        planProject(root, {
          projectId: "guide-" + index,
          resolveDir: resolveRoot,
        }).pipe(
          Effect.provide(NodePath.layer),
          Effect.mapError((error) => new Error("guide sample " + sample.name + ": " + error.message)),
        ),
      );
      expect(planned.manifest.project.entry).toBe("ballast.ts");
      expect(
        planned.manifest.params.length +
          planned.manifest.topics.length +
          (planned.manifest.artifacts ?? []).length,
      ).toBeGreaterThan(0);
      if (sample.name === "artifact") {
        expect(planned.manifest.artifacts?.length).toBe(1);
        expect(planned.artifacts.length).toBe(1);
        expect(planned.artifacts[0]?.htmlPath.endsWith("index.html")).toBe(true);
      }
    }
  }, 120_000);
});
