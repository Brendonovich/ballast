import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { listOrphanedDatabases, startRunDatabases } from "../src/service/database.ts";

describe("database orphans", () => {
  it("lists undeclared .sqlite files with sizes and skips sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "ballast-db-orphans-"));
    try {
      mkdirSync(join(dir, ".ballast", "db"), { recursive: true });
      const dbDir = join(dir, ".ballast", "db");
      writeFileSync(join(dbDir, "main.sqlite"), "hello");       // orphan, 5 bytes
      writeFileSync(join(dbDir, "main.sqlite-wal"), "x");       // sidecar, ignored
      writeFileSync(join(dbDir, "main.sqlite-shm"), "yy");      // sidecar, ignored
      writeFileSync(join(dbDir, "keep.sqlite"), "hi");          // declared, ignored
      writeFileSync(join(dbDir, "notes.txt"), "zzz");           // non-sqlite, ignored

      const result = listOrphanedDatabases(dbDir, new Set(["keep"]));
      expect(result).toEqual([{ name: "main", sizeBytes: 5 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the directory is missing", () => {
    const missing = join(tmpdir(), "ballast-db-definitely-missing");
    expect(listOrphanedDatabases(missing, new Set())).toEqual([]);
  });
});

// Count this process's descriptors on `file` with lsof (macOS and Linux).
const openHandles = (file: string): number | undefined => {
  try {
    const output = execFileSync("lsof", ["-n", "-P", "-Fn", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    return output.split("\n").filter((line) => line === "n" + file).length;
  } catch {
    return undefined;
  }
};

describe("run databases", () => {
  it.effect("reuses one connection per database across statements", () =>
    Effect.gen(function* () {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "ballast-db-reuse-")));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })));
      const databases = yield* startRunDatabases(dir);
      const run = (sql: string) =>
        databases.execute({ name: "main", method: "execute", sql, params: [] });
      yield* run("create table t (n integer)");
      yield* Effect.all(
        Array.from({ length: 20 }, () => run("insert into t values (1)")),
        { concurrency: "unbounded" },
      );
      for (let i = 0; i < 20; i++) yield* run("select count(*) from t");
      const handles = openHandles(join(dir, "main.sqlite"));
      if (handles !== undefined) expect(handles).toBe(1);
      expect(yield* run("select count(*) as n from t")).toEqual([{ n: 20 }]);
    }).pipe(Effect.scoped));
});
