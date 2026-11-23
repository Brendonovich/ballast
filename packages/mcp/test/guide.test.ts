import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { planProject } from "@ballast/planner";
import { afterEach, describe, expect, it } from "vitest";

import { GUIDE } from "../src/guide.ts";

const roots: Array<string> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const completeSamples = (): ReadonlyArray<string> =>
  Array.from(GUIDE.matchAll(/```ts title="ballast\.ts"\n([\s\S]*?)```/g)).flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );

describe("guide code samples", () => {
  it("contains complete ballast.ts samples", () => {
    expect(completeSamples().length).toBeGreaterThanOrEqual(2);
  });

  it("typechecks and plans every complete sample", async () => {
    const samples = completeSamples();
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const [index, source] of samples.entries()) {
      const root = await mkdtemp(join(tmpdir(), "ballast-guide-sample-" + index + "-"));
      roots.push(root);
      await writeFile(join(root, "ballast.ts"), source, "utf8");
      const planned = await Effect.runPromise(
        planProject(root, { projectId: "guide-sample-" + index }).pipe(
          Effect.mapError((error) => new Error("guide sample " + index + ": " + error.message)),
        ),
      );
      expect(planned.manifest.project.entry).toBe("ballast.ts");
      expect(planned.manifest.params.length + planned.manifest.topics.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
