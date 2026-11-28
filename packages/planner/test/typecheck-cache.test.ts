import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodePath } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { typecheckProject } from "../src/typecheck.ts";

const nodeTypes = dirname(createRequire(import.meta.url).resolve("@types/node/package.json"));

const copyNodeTypes = async (typeRoot: string): Promise<void> => {
  await cp(nodeTypes, join(typeRoot, "node"), { recursive: true, dereference: true });
};

const writeConfig = async (root: string, typeRoot: string): Promise<void> => {
  const config = {
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2024"],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      typeRoots: [typeRoot],
      types: ["node"],
    },
    include: ["**/*.ts"],
  };
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config, null, 2), "utf8");
  await writeFile(join(root, "ballast.ts"), "export default 1;\n", "utf8");
};

layer(NodePath.layer)("typecheck cache", (it) => {
  it.effect("retries missing types and keys on the resolved types target", () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-typecheck-cache-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(base, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      const root = join(base, "project");
      const types = join(base, "types");
      const current = join(types, "current");
      const typeRoot = join(current, "@types");
      yield* Effect.promise(() => mkdir(root, { recursive: true }));
      yield* Effect.promise(() => mkdir(typeRoot, { recursive: true }));
      yield* Effect.promise(() => writeConfig(root, typeRoot));

      // The type root exists (so the cache key is stable) but @types/node is
      // missing. This failure must not be cached.
      const first = yield* typecheckProject(root);
      expect(first.ok).toBe(false);
      expect(first.raw).toContain("TS2688");

      // Add the types without touching the project source or tsconfig. The
      // resolution key is unchanged, so only a fresh run can succeed.
      yield* Effect.promise(() => copyNodeTypes(typeRoot));
      const second = yield* typecheckProject(root);
      expect(second.ok, second.raw).toBe(true);

      // Repoint types/current without touching a source byte. The cached
      // success must not mask the newly missing @types/node.
      const v2 = join(types, "v2");
      yield* Effect.promise(() => mkdir(join(v2, "@types"), { recursive: true }));
      yield* Effect.promise(() => rm(current, { recursive: true, force: true }));
      yield* Effect.promise(() => symlink("v2", current, "dir"));
      const third = yield* typecheckProject(root);
      expect(third.ok).toBe(false);
      expect(third.raw).toContain("TS2688");
    }),
  );
});
