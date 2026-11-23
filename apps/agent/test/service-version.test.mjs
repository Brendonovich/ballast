import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceContentHash } from "../scripts/service-version.mjs";

const write = async (root, path, content) => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content, "utf8");
};

describe("service version", () => {
  it("hashes the whole stage and ignores version.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "ballast-service-version-"));
    try {
      await write(root, "main.mjs", "main-v1");
      await write(root, "plan-worker.mjs", "worker-v1");
      await write(root, "web/index.html", "<h1>Ballast</h1>");
      await write(root, "node_modules/@ballast/core/src/index.ts", "export const version = 1;");
      await write(root, "node_modules/effect/package.json", '{"name":"effect"}');

      const first = await serviceContentHash(root);
      expect(first).toMatch(/^[0-9a-f]{10}$/);

      // version.json is derived from the hash, so it must not feed back in.
      await write(root, "version.json", '{"version":"ignored"}');
      expect(await serviceContentHash(root)).toBe(first);

      // A copied type package can change without changing main.mjs. The
      // desktop must still see a new version and stage it.
      await write(root, "node_modules/@ballast/core/src/index.ts", "export const version = 2;");
      const second = await serviceContentHash(root);
      expect(second).not.toBe(first);

      await write(root, "web/index.html", "<h1>Ballast v2</h1>");
      expect(await serviceContentHash(root)).not.toBe(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
