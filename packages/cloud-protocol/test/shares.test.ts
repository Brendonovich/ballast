import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import {
  SHARE_MANIFEST_PATH,
  decodeShareManifest,
  diffShareManifests,
  encodeShareManifest,
  gitBlobSha,
  shareManifestHash,
  sharePathError,
  validateShareManifest,
  type ShareManifest,
} from "../src/index.ts";

const sha = (char: string) => char.repeat(40);

const manifest = (files: ShareManifest["files"]): ShareManifest => ({
  version: 1,
  name: "demo",
  files,
});

describe("share manifests", () => {
  it("computes git blob ids", async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await Effect.runPromise(gitBlobSha(new TextEncoder().encode("hello\n")))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    // The empty blob.
    expect(await Effect.runPromise(gitBlobSha(new Uint8Array()))).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("diffs added, modified, mode-changed and deleted files", () => {
    const from = manifest({
      "ballast.ts": { sha: sha("a"), size: 1, mode: "100644" },
      "src/keep.ts": { sha: sha("b"), size: 1, mode: "100644" },
      "src/gone.ts": { sha: sha("c"), size: 1, mode: "100644" },
      "bin/run.sh": { sha: sha("d"), size: 1, mode: "100644" },
    });
    const to = manifest({
      "ballast.ts": { sha: sha("e"), size: 2, mode: "100644" },
      "src/keep.ts": { sha: sha("b"), size: 1, mode: "100644" },
      "src/new.ts": { sha: sha("f"), size: 3, mode: "100644" },
      "bin/run.sh": { sha: sha("d"), size: 1, mode: "100755" },
    });
    const diff = diffShareManifests(from, to);
    expect(diff.changed.map((entry) => entry.path)).toEqual(["ballast.ts", "bin/run.sh", "src/new.ts"]);
    expect(diff.deleted).toEqual(["src/gone.ts"]);
    expect(diff.unchanged).toBe(1);
  });

  it("treats a missing base as a full snapshot", () => {
    const to = manifest({
      "b.ts": { sha: sha("1"), size: 1, mode: "100644" },
      "a.ts": { sha: sha("2"), size: 1, mode: "100644" },
    });
    const diff = diffShareManifests(undefined, to);
    expect(diff.changed.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    expect(diff.deleted).toEqual([]);
  });

  it("encodes canonically and round-trips", async () => {
    const left = manifest({
      "z.ts": { sha: sha("1"), size: 1, mode: "100644" },
      "a.ts": { sha: sha("2"), size: 2, mode: "100755" },
    });
    const right = manifest({
      "a.ts": { sha: sha("2"), size: 2, mode: "100755" },
      "z.ts": { sha: sha("1"), size: 1, mode: "100644" },
    });
    expect(encodeShareManifest(left)).toBe(encodeShareManifest(right));
    expect(await Effect.runPromise(shareManifestHash(left))).toBe(
      await Effect.runPromise(shareManifestHash(right)),
    );
    const decoded = await Effect.runPromise(decodeShareManifest(encodeShareManifest(left)));
    expect(decoded).toEqual(right);
  });

  it("rejects unsafe or reserved paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:/x",
      "../escape.ts",
      "a/../b.ts",
      "a//b.ts",
      "./a.ts",
      "a\\b.ts",
      ".ballast/settings.json",
      "src/node_modules/x.js",
      ".git/config",
      "dist/out.js",
      SHARE_MANIFEST_PATH,
      ".env",
      "config/.env.local",
      ".DS_Store",
    ]) {
      expect(sharePathError(path), path).toBeDefined();
    }
    for (const path of ["ballast.ts", "src/a.ts", ".gitignore", "artifacts/x/main.tsx"]) {
      expect(sharePathError(path), path).toBeUndefined();
    }
  });

  it("rejects case collisions, file/directory clashes and oversize shares", async () => {
    const fails = async (value: ShareManifest) =>
      Exit.isFailure(await Effect.runPromiseExit(validateShareManifest(value)));
    expect(
      await fails(
        manifest({
          "A.ts": { sha: sha("1"), size: 1, mode: "100644" },
          "a.ts": { sha: sha("2"), size: 1, mode: "100644" },
        }),
      ),
    ).toBe(true);
    expect(
      await fails(
        manifest({
          src: { sha: sha("1"), size: 1, mode: "100644" },
          "src/a.ts": { sha: sha("2"), size: 1, mode: "100644" },
        }),
      ),
    ).toBe(true);
    expect(
      await fails(manifest({ "big.bin": { sha: sha("1"), size: 9 * 1024 * 1024, mode: "100644" } })),
    ).toBe(true);
    expect(
      await fails(manifest({ "ok.ts": { sha: sha("1"), size: 10, mode: "100644" } })),
    ).toBe(false);
  });

  it("rejects malformed manifest JSON", async () => {
    const exit = await Effect.runPromiseExit(
      decodeShareManifest(JSON.stringify({ version: 1, name: "x", files: { "a.ts": { sha: "nope", size: 1, mode: "100644" } } })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
