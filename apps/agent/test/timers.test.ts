import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { withAgentClient } from "../src/service/client.ts";
import type { LiveAgentClient } from "../src/service/client.ts";
import { readServiceRegistration } from "../src/service/config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const agentNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const timerScript = (options: {
  readonly delay: string;
  readonly onStale: "drop" | "deliver";
  readonly maxAgeMs: number;
  readonly payloadType?: "number" | "string";
  readonly gated?: boolean;
}): string =>
  [
    'import * as Ballast from "@ballast/core";',
    'import { Effect, Schema } from "effect";',
    "",
    "const Payload = Schema.Struct({ n: Schema." +
      (options.payloadType === "string" ? "String" : "Number") +
      " });",
    "",
    "export default Effect.gen(function* () {",
    '  const n = yield* Ballast.Param.number("n", { default: 1 });',
    '  const schedule = yield* Ballast.Param.boolean("schedule", { default: true });',
    "  const timer = yield* Ballast.Timer.subscribe(",
    '    "cooldown",',
    "    Payload,",
    '    (fire) => Effect.log("TIMER_FIRED " + fire.key + " " + fire.payload.n + " " + fire.lateByMs),',
    '    { title: "Cooldown", onStale: "' + options.onStale + '", maxAgeMs: ' + options.maxAgeMs + " },",
    "  );",
    '  yield* Ballast.run("timer-loop",',
    "    Effect.gen(function* () {",
    ...(options.gated === true ? ["      if (!(yield* schedule)) return;"] : []),
    "      const value = yield* n;",
    '      yield* timer.after("one", "' + options.delay + '", { n: value });',
    '      yield* Effect.log("TIMER_SCHEDULED " + value);',
    "    }),",
    "  );",
    "});",
    "",
  ].join("\n");

const makeProject = (source: string) =>
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "ballast-timer-test-"));
    const project = join(root, "project");
    await mkdir(join(project, "scripts"), { recursive: true });
    await mkdir(join(project, "node_modules", "@ballast"), { recursive: true });
    await symlink(
      join(agentNodeModules, "@ballast", "core"),
      join(project, "node_modules", "@ballast", "core"),
      "dir",
    );
    await symlink(
      join(agentNodeModules, "effect"),
      join(project, "node_modules", "effect"),
      "dir",
    );
    await writeFile(join(project, "scripts", "timer.ts"), source, "utf8");
    return root;
  });

interface Service {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: () => Effect.Effect<void>;
}

const startService = (root: string): Effect.Effect<Service, Error> =>
  Effect.gen(function* () {
    // A stopped service leaves its registration behind; remove it so the
    // readiness check below cannot observe the previous process's port.
    yield* Effect.promise(() => rm(join(root, "state", "service.json"), { force: true }));
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        bin,
        "serve",
        "--port",
        "0",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: "1",
          BALLAST_STATE_DIR: join(root, "state"),
          BALLAST_DATA_DIR: join(root, "data"),
          BALLAST_LOG_DIR: join(root, "logs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const stop = () =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const deadline = Date.now() + 10_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          yield* Effect.sleep("50 millis");
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        yield* Effect.sleep("100 millis");
      });
    yield* waitFor(
      "service.json",
      () =>
        Effect.promise(async () => {
          const registration = await Effect.runPromise(readServiceRegistration(join(root, "state")).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer)));
          return registration?.pid === child.pid ? registration : undefined;
        }),
      30_000,
    );
    return { child, output: () => output, stop };
  });

const timerPayloadNumber = (payload: unknown): number | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Readonly<Record<string, unknown>>)["n"];
  return typeof value === "number" ? value : undefined;
};

const waitFor = <A, E>(
  label: string,
  read: () => Effect.Effect<A | undefined, E>,
  timeoutMs = 20_000,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* read();
      if (value !== undefined) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.fail(new Error("Timed out waiting for " + label));
  });

const envFor = (root: string) => ({
  BALLAST_STATE_DIR: join(root, "state"),
  BALLAST_DATA_DIR: join(root, "data"),
});

const call = <A, E>(
  root: string,
  use: (client: LiveAgentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  withAgentClient(use, envFor(root)).pipe(
    Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer), Effect.provide(NodeCrypto.layer),
    Effect.mapError((error) => {
      if (error instanceof Error) return error;
      if (typeof error === "object" && error !== null) {
        const message = (error as { readonly message?: unknown }).message;
        if (typeof message === "string") return new Error(message);
      }
      return new Error(JSON.stringify(error));
    }),
  );

const waitForLog = (
  root: string,
  projectId: string,
  scriptId: string,
  predicate: (message: string) => boolean,
): Effect.Effect<string, Error> =>
  call(root, (client) =>
    client.StreamLogs({ projectId, scriptId }).pipe(
      Stream.filter((entry) => predicate(entry.message)),
      Stream.take(1),
      Stream.runCollect,
    ),
  ).pipe(
    Effect.timeout(Duration.seconds(60)),
    Effect.map((entries) => entries[0]?.message ?? ""),
    Effect.mapError((error) =>
      error instanceof Error ? error : new Error(String(error)),
    ),
  );

const addAndStart = (root: string, project: string) =>
  call(root, (client) =>
    Effect.gen(function* () {
      const detail = yield* client.AddProject({ path: project, name: "Timers" });
      const scriptId = "scripts/timer.ts";
      yield* client.StartScript({ projectId: detail.summary.id, scriptId });
      return { projectId: detail.summary.id, scriptId };
    }),
  );

describe("durable timers through the service", () => {
  it.live("lists declarations, survives a restart and fires once", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(
        timerScript({ delay: "3 seconds", onStale: "deliver", maxAgeMs: 60_000, gated: true }),
      );
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(project, { recursive: true }));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_SCHEDULED"),
      );
      yield* call(root, (client) =>
        client.SetScriptParam({ ...started, key: "schedule", value: false }),
      );
      yield* Effect.sleep("500 millis");

      const detail = yield* call(root, (client) => client.GetScript(started));
      expect(detail.manifest.timers.map((timer) => timer.name)).toEqual(["cooldown"]);
      const pending = yield* call(root, (client) => client.ListTimers({ projectId: started.projectId }));
      expect(pending.timers).toHaveLength(1);
      expect(pending.timers[0]?.state).toBe("pending");

      yield* service.stop();
      yield* Effect.sleep("1 second");
      const restarted = yield* startService(root);
      yield* Effect.addFinalizer(() => restarted.stop());
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_FIRED one"),
      );
      yield* Effect.sleep("1 second");
      const finished = yield* call(root, (client) =>
        client.ListTimers({ projectId: started.projectId, includeFinished: true }),
      );
      expect(finished.timers).toHaveLength(1);
      expect(finished.timers[0]?.state).toBe("fired");
      const duplicate = yield* call(root, (client) =>
        client.StreamLogs({ projectId: started.projectId, scriptId: started.scriptId }).pipe(
          Stream.filter((entry) => entry.message.includes("TIMER_FIRED one")),
          Stream.take(2),
          Stream.runCollect,
        ),
      ).pipe(Effect.timeout(Duration.seconds(1)), Effect.exit);
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
    120_000,
  );

  it.live("keeps pending entries while stopped and delivers late", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(timerScript({ delay: "6 seconds", onStale: "deliver", maxAgeMs: 60_000 }));
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(project, { recursive: true }));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      yield* waitFor("the pending timer", () =>
        call(root, (client) => client.ListTimers({ projectId: started.projectId })).pipe(
          Effect.map((result) => result.timers.find((timer) => timer.state === "pending")),
        ),
      );
      yield* call(root, (client) => client.StopScript(started));
      // Keep the restarted worker from scheduling the same key again, so the
      // overdue entry loaded from disk is what fires.
      yield* call(root, (client) =>
        client.SetScriptParam({ ...started, key: "schedule", value: false }),
      );
      yield* Effect.sleep("6.5 seconds");
      yield* service.stop();

      const restarted = yield* startService(root);
      yield* Effect.addFinalizer(() => restarted.stop());
      yield* call(root, (client) => client.StartScript(started));
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_FIRED one"),
      );
    }),
    120_000,
  );

  it.live("drops a stale timer after the max age", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(
        timerScript({ delay: "2 seconds", onStale: "drop", maxAgeMs: 100, gated: true }),
      );
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(project, { recursive: true }));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_SCHEDULED"),
      );
      yield* call(root, (client) =>
        client.SetScriptParam({ ...started, key: "schedule", value: false }),
      );
      yield* Effect.sleep("500 millis");
      yield* call(root, (client) => client.StopScript(started));
      yield* Effect.sleep("2.5 seconds");

      yield* call(root, (client) => client.StartScript(started));
      yield* waitFor("the stale timer to drop", () =>
        call(root, (client) =>
          client.ListTimers({ projectId: started.projectId, includeFinished: true }),
        ).pipe(
          Effect.map((result) => result.timers.find((timer) => timer.state === "dropped")),
        ),
      );
    }),
    120_000,
  );

  it.live("drops pending timers when the payload schema changes", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(
        timerScript({ delay: "60 seconds", onStale: "deliver", maxAgeMs: 60_000, gated: true }),
      );
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(project, { recursive: true }));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_SCHEDULED"),
      );

      yield* call(root, (client) =>
        client.SetScriptParam({ ...started, key: "schedule", value: false }),
      );
      yield* Effect.sleep("1 second");
      yield* Effect.promise(() =>
        writeFile(
          join(project, "scripts", "timer.ts"),
          timerScript({ delay: "60 seconds", onStale: "deliver", maxAgeMs: 60_000, gated: true, payloadType: "string" }),
          "utf8",
        ),
      );
      yield* waitFor("the stale schema timer to drop", () =>
        call(root, (client) =>
          client.ListTimers({ projectId: started.projectId, includeFinished: true }),
        ).pipe(
          Effect.map((result) => result.timers.find((timer) => timer.state === "dropped")),
        ),
      );
    }),
    120_000,
  );

  it.live("quarantines a corrupt store and deletes it with the project", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(timerScript({ delay: "60 seconds", onStale: "deliver", maxAgeMs: 60_000 }));
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(join(project, ".ballast"), { recursive: true }));
      yield* Effect.promise(() => writeFile(join(project, ".ballast", "timers.json"), "{ this is not json", "utf8"));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      const files = yield* Effect.promise(() => readdir(join(project, ".ballast")));
      expect(files.some((file) => file.startsWith("timers.json.corrupt-"))).toBe(true);
      // The corrupt file is gone; write a valid store so project removal has a
      // file to delete without requiring another worker generation.
      yield* Effect.promise(() =>
        writeFile(join(project, ".ballast", "timers.json"), JSON.stringify({ version: 1, timers: [] }), "utf8"),
      );
      yield* call(root, (client) => client.RemoveProject({ projectId: started.projectId }));
      yield* Effect.promise(async () => {
        try {
          await readFile(join(project, ".ballast", "timers.json"), "utf8");
          throw new Error("timers.json should be gone");
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes("should be gone")) throw cause;
        }
      });
    }),
    120_000,
  );

  it.live("gives a due timer to exactly one generation across a swap", () =>
    Effect.gen(function* () {
      const root = yield* makeProject(
        // Long enough that the param-driven restart finishes before the timer
        // is due even when the full suite is competing for CPU.
        timerScript({ delay: "15 seconds", onStale: "deliver", maxAgeMs: 60_000 }),
      );
      const project = join(root, "project");
      yield* Effect.promise(() => mkdir(project, { recursive: true }));
      const service = yield* startService(root);
      yield* Effect.addFinalizer(() => service.stop());
      const started = yield* addAndStart(root, project);
      yield* waitFor("the first pending timer", () =>
        call(root, (client) => client.ListTimers({ projectId: started.projectId })).pipe(
          Effect.map((result) =>
            result.timers.find(
              (timer) => timer.state === "pending" && timerPayloadNumber(timer.payload) === 1,
            ),
          ),
        ),
      );
      yield* Effect.sleep("1.5 seconds");
      yield* call(root, (client) =>
        client.SetScriptParam({ ...started, key: "n", value: 2 }),
      );
      yield* waitFor("the restarted timer with n=2", () =>
        call(root, (client) => client.ListTimers({ projectId: started.projectId })).pipe(
          Effect.map((result) =>
            result.timers.find(
              (timer) => timer.state === "pending" && timerPayloadNumber(timer.payload) === 2,
            ),
          ),
        ),
      );
      yield* waitForLog(root, started.projectId, started.scriptId, (message) =>
        message.includes("TIMER_FIRED one 2"),
      );
      yield* Effect.sleep("1 second");
      const duplicate = yield* call(root, (client) =>
        client.StreamLogs({ projectId: started.projectId, scriptId: started.scriptId }).pipe(
          Stream.filter((entry) => entry.message.includes("TIMER_FIRED one")),
          Stream.take(2),
          Stream.runCollect,
        ),
      ).pipe(Effect.timeout(Duration.seconds(1)), Effect.exit);
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
    120_000,
  );
});
