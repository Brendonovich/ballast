import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { startMockObsServer } from "./mock-obs-server.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(new URL("../../../examples/obs-scene.ts", import.meta.url));

interface CliProcess {
  readonly output: string;
  readonly code: number;
}

const spawnCli = (args: ReadonlyArray<string>) =>
  spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings=ExperimentalWarning",
      bin,
      "run",
      example,
      ...args,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

/** Run the CLI until its output contains every marker, then kill it. */
const runUntil = (
  args: ReadonlyArray<string>,
  markers: ReadonlyArray<string>,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const child = spawnCli(args);
    return yield* Effect.callback<string, Error>((resume) => {
      let output = "";
      let settled = false;

      const check = (chunk: Buffer): void => {
        output += chunk.toString();
        if (settled) return;
        if (markers.every((marker) => output.includes(marker))) {
          settled = true;
          resume(Effect.succeed(output));
        }
      };

      const onExit = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new Error("CLI exited with code " + String(code) + " before matching\n" + output),
          ),
        );
      };

      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.on("exit", onExit);

      return Effect.sync(() => {
        child.stdout.off("data", check);
        child.stderr.off("data", check);
        child.off("exit", onExit);
        child.kill("SIGTERM");
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  });

/** Run the CLI to completion and collect its output and exit code. */
const runToExit = (args: ReadonlyArray<string>): Effect.Effect<CliProcess, Error> =>
  Effect.gen(function* () {
    const child = spawnCli(args);
    return yield* Effect.callback<CliProcess, Error>((resume) => {
      let output = "";
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
      };
      const onExit = (code: number | null): void => {
        resume(Effect.succeed({ output, code: code ?? -1 }));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", onExit);
      return Effect.sync(() => {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("exit", onExit);
        if (!child.killed) child.kill("SIGTERM");
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  });

const withServer = <A, E>(
  use: (server: Awaited<ReturnType<typeof startMockObsServer>>) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startMockObsServer(),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
        (instance) => Effect.promise(() => instance.close()),
      );
      return yield* use(server);
    }),
  );

const connection = (server: { readonly url: string }): ReadonlyArray<string> => [
  "--connection",
  "obs/main=" + server.url,
];

describe("ballast run with OBS", () => {
  it.live(
    "sets the scene and logs the CurrentProgramSceneChanged event",
    () =>
      withServer((server) =>
        Effect.gen(function* () {
          const output = yield* runUntil(
            [...connection(server), "--param", "scene=Scene 2"],
            ["[obs:main] connected", "set scene Scene 2", "scene now Scene 2"],
          );

          expect(output).toContain("[obs:main] connected (" + server.url + ")");
          expect(server.currentScene()).toBe("Scene 2");
          expect(server.requests()).toContain("GetSceneList");
          expect(server.requests()).toContain("SetCurrentProgramScene");
        }),
      ),
    40_000,
  );

  it.live(
    "refuses to start without a required param",
    () =>
      withServer((server) =>
        Effect.gen(function* () {
          const result = yield* runToExit(connection(server));
          expect(result.code).toBe(1);
          expect(result.output).toContain('Missing required param "scene"');
          expect(result.output).toContain("--param scene=<value>");
        }),
      ),
    40_000,
  );

  it.live(
    "rejects a scene that OBS does not have",
    () =>
      withServer((server) =>
        Effect.gen(function* () {
          const result = yield* runToExit([
            ...connection(server),
            "--param",
            "scene=Missing scene",
          ]);
          expect(result.code).toBe(1);
          expect(result.output).toContain(
            'Param "scene" value "Missing scene" is not available',
          );
          expect(result.output).toContain("Available: Scene 1, Scene 2");
        }),
      ),
    40_000,
  );
});
