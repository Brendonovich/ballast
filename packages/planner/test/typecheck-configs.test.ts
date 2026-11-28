import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { generatedConfigText } from "../src/generated-config.ts";
import { typecheckProject } from "../src/typecheck.ts";

layer(NodePath.layer)("typecheck configs", (it) => {
  it.effect("a generated artifacts tsconfig follows the generated base once the root tsconfig is gone", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-typecheck-configs-")));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );
      yield* Effect.promise(async () => {
        await mkdir(join(root, "artifacts"), { recursive: true });
        await writeFile(join(root, "ballast.ts"), "export default 1;\n", "utf8");
        await writeFile(join(root, "artifacts", "value.ts"), "export const value = 1;\n", "utf8");
        await writeFile(
          join(root, "artifacts", "page.ts"),
          'import { value } from "./value.ts";\nexport const page = value;\n',
          "utf8",
        );
        // Written while the project still had a root tsconfig.json.
        await writeFile(
          join(root, "artifacts", "tsconfig.json"),
          generatedConfigText({ extends: "../tsconfig.json", include: ["**/*.ts"] }),
          "utf8",
        );
      });

      const result = yield* typecheckProject(root);
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      const artifactConfig = yield* Effect.promise(() =>
        readFile(join(root, "artifacts", "tsconfig.json"), "utf8"),
      );
      expect(artifactConfig).toContain('"extends": "../.ballast/tsconfig.generated.json"');
    }),
  );
});
