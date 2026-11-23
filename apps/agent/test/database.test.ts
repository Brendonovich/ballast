import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { listOrphanedDatabases } from "../src/service/database.ts";

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
