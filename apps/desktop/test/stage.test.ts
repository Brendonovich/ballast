import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopConfig } from "../src/main/config.ts";
import {
  asStage,
  cleanStages,
  readInstalledStage,
  removeInstalledStage,
  resolveServiceBuild,
  stageService,
  writeInstalledStage,
} from "../src/main/service/stage.ts";
import { configFor } from "./support.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function fixture(version = "1.0.0"): Promise<{ root: string; build: string; config: DesktopConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ballast-stage-"));
  roots.push(root);
  const build = path.join(root, "build");
  await mkdir(path.join(build, "web"), { recursive: true });
  await writeFile(path.join(build, "main.mjs"), "// main " + version);
  await writeFile(path.join(build, "plan-worker.mjs"), "// worker");
  await writeFile(path.join(build, "web", "index.html"), "<!doctype html><title>ui</title>");
  await writeFile(path.join(build, "version.json"), JSON.stringify({ version }));
  const config = configFor(root, { env: { BALLAST_SERVICE_BUILD_DIR: build } });
  return { root, build, config };
}

describe("service staging", () => {
  it("resolves the build version and copies the stage once without overwriting it", async () => {
    const { config, build } = await fixture("1.2.3");
    const resolved = await resolveServiceBuild(config);
    expect(resolved).toEqual({ version: "1.2.3", directory: build });

    const stage = await stageService(config, resolved);
    expect(stage.directory).toBe(path.join(config.stageRoot, "1.2.3"));
    expect(asStage(stage).entry).toBe(path.join(stage.directory, "main.mjs"));
    expect(await readFile(path.join(stage.directory, "web", "index.html"), "utf8")).toContain("ui");

    await writeFile(path.join(stage.directory, "main.mjs"), "// running generation");
    const again = await stageService(config, resolved);
    expect(again.directory).toBe(stage.directory);
    expect(await readFile(path.join(again.directory, "main.mjs"), "utf8")).toBe("// running generation");
  });

  it("fails loudly when the build or an existing stage is incomplete", async () => {
    const { config, build } = await fixture();
    await rm(path.join(build, "main.mjs"));
    await expect(resolveServiceBuild(config)).rejects.toThrow(/no main.mjs/);

    const incomplete = configFor(path.dirname(config.userDataDir), {
      env: { BALLAST_SERVICE_BUILD_DIR: build, BALLAST_SERVICE_VERSION: "9.9.9" },
    });
    await mkdir(path.join(incomplete.stageRoot, "9.9.9"), { recursive: true });
    await expect(stageService(incomplete, { version: "9.9.9", directory: build })).rejects.toThrow(/incomplete/);
  });

  it("tracks installed.json and cleans old stages", async () => {
    const { config } = await fixture("1.0.0");
    await mkdir(path.join(config.stageRoot, "0.9.0"), { recursive: true });
    await mkdir(path.join(config.stageRoot, "1.0.0"), { recursive: true });
    await mkdir(path.join(config.stageRoot, "1.1.0"), { recursive: true });
    await mkdir(path.join(config.stageRoot, ".1.2.0.123.tmp"), { recursive: true });
    await writeInstalledStage(config, { version: "1.0.0", directory: path.join(config.stageRoot, "1.0.0") });
    expect(await readInstalledStage(config)).toEqual({
      version: "1.0.0",
      directory: path.join(config.stageRoot, "1.0.0"),
    });

    const removed = await cleanStages(config, ["1.0.0", "1.1.0"]);
    expect(removed.sort()).toEqual([".1.2.0.123.tmp", "0.9.0"]);
    expect(await readInstalledStage(config)).toEqual({
      version: "1.0.0",
      directory: path.join(config.stageRoot, "1.0.0"),
    });

    await removeInstalledStage(config);
    expect(await readInstalledStage(config)).toBeUndefined();
  });

  it("rejects version names that could escape the stage root", async () => {
    const { config } = await fixture();
    await expect(stageService(config, { version: "../escape", directory: config.serviceBuildDir })).rejects.toThrow(
      /invalid service version/,
    );
  });
});
