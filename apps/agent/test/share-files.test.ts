import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { diffShareManifests, gitBlobSha } from "@ballast/cloud-protocol";
import {
  applyShareFiles,
  collectShareFiles,
  divergentFiles,
  manifestOf,
  type ShareFile,
} from "../src/service/share-files.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)));

const ok = async <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> => {
  const exit = await run(effect);
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

const file = async (path: string, text: string, mode: ShareFile["mode"] = "100644"): Promise<ShareFile> => {
  const bytes = new TextEncoder().encode(text);
  return { path, bytes, mode, sha: await Effect.runPromise(gitBlobSha(bytes)) };
};

const tree = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const relative = prefix === "" ? name : prefix + "/" + name;
      if (statSync(absolute).isDirectory()) walk(absolute, relative);
      else out[relative] = readFileSync(absolute, "utf8");
    }
  };
  walk(root, "");
  return out;
};

const withProject = async (use: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "ballast-share-files-"));
  try {
    await use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("share files", () => {
  it("collects shareable files and skips machine-local ones", () =>
    withProject(async (root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".ballast"), { recursive: true });
      mkdirSync(join(root, "node_modules", "x"), { recursive: true });
      writeFileSync(join(root, "ballast.ts"), "export default 1;\n");
      writeFileSync(join(root, "src", "a.ts"), "a\n");
      writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(root, "run.sh"), 0o755);
      writeFileSync(join(root, ".ballast", "settings.json"), "{}");
      writeFileSync(join(root, "node_modules", "x", "index.js"), "x");
      writeFileSync(join(root, ".env"), "SECRET=1");
      writeFileSync(join(root, "ballast.share.json"), "{}");
      symlinkSync(join(root, "ballast.ts"), join(root, "link.ts"));
      const files = await ok(collectShareFiles(root));
      expect(files.map((entry) => [entry.path, entry.mode])).toEqual([
        ["ballast.ts", "100644"],
        ["run.sh", "100755"],
        ["src/a.ts", "100644"],
      ]);
      const manifest = await ok(manifestOf("demo", files));
      expect(manifest.files["src/a.ts"]?.sha).toBe(files[2]?.sha);
    }));

  it("swaps changed files in, deletes removed ones and cleans up", () =>
    withProject(async (root) => {
      mkdirSync(join(root, "src", "old"), { recursive: true });
      writeFileSync(join(root, "ballast.ts"), "v1\n");
      writeFileSync(join(root, "src", "keep.ts"), "keep\n");
      writeFileSync(join(root, "src", "old", "gone.ts"), "gone\n");
      const files = [await file("ballast.ts", "v2\n"), await file("src/new/added.ts", "added\n")];
      await ok(applyShareFiles({ root, files, deleted: ["src/old/gone.ts"] }));
      expect(tree(root)).toEqual({
        "ballast.ts": "v2\n",
        "src/keep.ts": "keep\n",
        "src/new/added.ts": "added\n",
      });
      // Emptied directories are pruned; no staging or backup is left behind.
      expect(existsSync(join(root, "src", "old"))).toBe(false);
      expect(readdirSync(join(root, ".ballast"))).toEqual([]);
    }));

  it("refuses files that do not match their hash without touching the project", () =>
    withProject(async (root) => {
      writeFileSync(join(root, "ballast.ts"), "v1\n");
      const good = await file("ballast.ts", "v2\n");
      const tampered: ShareFile = { ...(await file("src/a.ts", "a\n")), bytes: new TextEncoder().encode("evil\n") };
      const exit = await run(applyShareFiles({ root, files: [good, tampered], deleted: ["ballast.ts"] }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(tree(root)).toEqual({ "ballast.ts": "v1\n" });
    }));

  it("rejects paths that escape the project", () =>
    withProject(async (root) => {
      for (const path of ["../escape.ts", "/abs.ts", ".ballast/settings.json", "a/../../b.ts"]) {
        const bad: ShareFile = { ...(await file("x.ts", "x\n")), path };
        const exit = await run(applyShareFiles({ root, files: [bad], deleted: [] }));
        expect(Exit.isFailure(exit), path).toBe(true);
      }
      const deleteOutside = await run(applyShareFiles({ root, files: [], deleted: ["../outside.ts"] }));
      expect(Exit.isFailure(deleteOutside)).toBe(true);
    }));

  it("rolls back every completed step when the swap fails midway", () =>
    withProject(async (root) => {
      writeFileSync(join(root, "a.ts"), "a1\n");
      writeFileSync(join(root, "b.ts"), "b1\n");
      // "blocker" is a file locally, so writing blocker/c.ts fails after a.ts
      // and b.ts were already swapped.
      writeFileSync(join(root, "blocker"), "file\n");
      const files = [
        await file("a.ts", "a2\n"),
        await file("b.ts", "b2\n"),
        await file("blocker/c.ts", "c\n"),
      ];
      const exit = await run(applyShareFiles({ root, files, deleted: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(tree(root)).toEqual({ "a.ts": "a1\n", "b.ts": "b1\n", blocker: "file\n" });
      expect(readdirSync(join(root, ".ballast"))).toEqual([]);
    }));

  it("reports local edits that diverge from the installed manifest", () =>
    withProject(async (root) => {
      writeFileSync(join(root, "a.ts"), "a\n");
      writeFileSync(join(root, "b.ts"), "b\n");
      const manifest = await ok(manifestOf("demo", await ok(collectShareFiles(root))));
      writeFileSync(join(root, "a.ts"), "edited\n");
      rmSync(join(root, "b.ts"));
      expect(await ok(divergentFiles(root, manifest))).toEqual(["a.ts", "b.ts"]);
    }));

  it("applies exactly the manifest diff between two versions", () =>
    withProject(async (root) => {
      const v1 = [await file("ballast.ts", "1\n"), await file("src/a.ts", "a\n"), await file("src/b.ts", "b\n")];
      await ok(applyShareFiles({ root, files: v1, deleted: [] }));
      const before = await ok(manifestOf("demo", v1));
      const v2 = [await file("ballast.ts", "2\n"), await file("src/a.ts", "a\n"), await file("src/c.ts", "c\n")];
      const after = await ok(manifestOf("demo", v2));
      const diff = diffShareManifests(before, after);
      const changed = v2.filter((entry) => diff.changed.some((change) => change.path === entry.path));
      expect(changed.map((entry) => entry.path)).toEqual(["ballast.ts", "src/c.ts"]);
      await ok(applyShareFiles({ root, files: changed, deleted: diff.deleted }));
      expect(tree(root)).toEqual({ "ballast.ts": "2\n", "src/a.ts": "a\n", "src/c.ts": "c\n" });
      const collected = await ok(collectShareFiles(root));
      expect(await ok(manifestOf("demo", collected))).toEqual(after);
    }));
});
