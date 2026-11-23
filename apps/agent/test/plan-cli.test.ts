import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(new URL("../../../examples/stream-dashboard", import.meta.url));

describe("plan command", () => {
  it.live(
    "plans a project directory with artifact imports from a foreign cwd",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-plan-cli-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
        );
        const project = join(root, "stream-dashboard");
        yield* Effect.promise(() => cp(example, project, { recursive: true }));

        const result = yield* Effect.promise(() =>
          exec(
            process.execPath,
            [
              "--experimental-strip-types",
              "--no-warnings=ExperimentalWarning",
              bin,
              "plan",
              project,
            ],
            { cwd: root, maxBuffer: 10 * 1024 * 1024 },
          ),
        );
        const manifest: unknown = JSON.parse(result.stdout);
        expect(manifest).toMatchObject({
          project: { id: "stream-dashboard", entry: "ballast.ts" },
          artifacts: [{ name: "dashboard" }],
        });

        const html = yield* Effect.promise(() =>
          readFile(join(project, ".ballast", "artifacts", "dashboard", "index.html"), "utf8"),
        );
        expect(html).toContain("bootstrap.js");
      }),
    30_000,
  );
});
