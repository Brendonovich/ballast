import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { findRunningService, stopService } from "../src/service/background.ts";
import type { Environment } from "../src/service/config.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

const cli = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.promise(async () => {
    const result = await run(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, ...args],
      { cwd: repoRoot, env, maxBuffer: 10 * 1024 * 1024 },
    );
    return `${result.stdout}${result.stderr}`;
  });

const isolated = (root: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
  for (const key of [
    "BALLAST_STATE_DIR",
    "BALLAST_DATA_DIR",
    "BALLAST_LOG_DIR",
    "BALLAST_SERVICE_URL",
    "BALLAST_SERVICE_TOKEN",
    "BALLAST_SERVICE_PORT",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: root,
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    BALLAST_PROJECTS_DIR: join(root, "projects"),
  };
};

const withState = (base: NodeJS.ProcessEnv, stateDir: string, dataDir: string, logDir: string): Environment => ({
  ...base,
  BALLAST_STATE_DIR: stateDir,
  BALLAST_DATA_DIR: dataDir,
  BALLAST_LOG_DIR: logDir,
});

const running = (env: Environment) =>
  findRunningService(env).pipe(Effect.provide(NodeServices.layer));

describe("service CLI target selection", () => {
  it.live("stops the service named by --state-dir and leaves another one running", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-service-cli-")));
      const base = isolated(root);
      const stateA = join(root, "a", "state");
      const dataA = join(root, "a", "data");
      const stateB = join(root, "b", "state");
      const dataB = join(root, "b", "data");
      const envA = withState(base, stateA, dataA, join(root, "a", "logs"));
      const envB = withState(base, stateB, dataB, join(root, "b", "logs"));

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [stopService(envA), stopService(envB)].map((stop) =>
            stop.pipe(Effect.provide(NodeServices.layer), Effect.ignore),
          ),
          { discard: true },
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(root, { recursive: true, force: true })).pipe(Effect.ignore),
      );

      // Start A through the environment, the way serve resolves it.
      const startedA = yield* cli(["service", "start"], envA);
      expect(startedA).toContain(join(stateA, "service.json"));
      const serviceA = yield* running(envA);
      expect(serviceA?.file).toBe(join(stateA, "service.json"));

      // Start B through flags in a second state dir.
      const startedB = yield* cli(
        ["service", "start", "--state-dir", stateB, "--data-dir", dataB],
        base,
      );
      expect(startedB).toContain(join(stateB, "service.json"));
      const serviceB = yield* running(envB);
      expect(serviceB?.file).toBe(join(stateB, "service.json"));
      expect(serviceB?.registration.pid).not.toBe(serviceA?.registration.pid);

      const statusA = yield* cli(["service", "status", "--state-dir", stateA], base);
      expect(statusA).toContain("running service.json " + join(stateA, "service.json"));
      expect(statusA).toContain("pid " + serviceA?.registration.pid);
      expect(statusA).toContain(serviceA?.registration.url ?? "missing-url");

      const stoppedA = yield* cli(["service", "stop", "--state-dir", stateA], base);
      expect(stoppedA).toContain("stopping service.json " + join(stateA, "service.json"));
      expect(stoppedA).toContain("stopped Ballast");

      expect(yield* running(envA)).toBeUndefined();
      const stillB = yield* running(envB);
      expect(stillB?.registration.pid).toBe(serviceB?.registration.pid);

      // An explicit state dir with no service must not fall back to the
      // default data dir and stop B.
      const missingA = yield* cli(["service", "stop", "--state-dir", stateA], base);
      expect(missingA).toContain("service is not running");
      expect(yield* running(envB)).toBeDefined();

      const statusB = yield* cli(["service", "status", "--state-dir", stateB], base);
      expect(statusB).toContain("running service.json " + join(stateB, "service.json"));
      expect(statusB).toContain("pid " + serviceB?.registration.pid);
    }),
    120_000,
  );
});
