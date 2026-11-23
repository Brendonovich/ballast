import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { startSceneifyObs } from "./support/sceneify-obs.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(new URL("../../../examples/obs-sceneify.ts", import.meta.url));

/** Start `ballast run` and wait until it reports the OBS connection. */
const startCli = (args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly output: () => string; readonly kill: () => void }, Error>((resume) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, "run", example, ...args],
        { cwd: repoRoot, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let started = false;
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        if (!started && output.includes("[obs:main] connected")) {
          started = true;
          resume(Effect.succeed({ output: () => output, kill: () => child.kill("SIGTERM") }));
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => {
        if (!started) resume(Effect.fail(new Error("CLI exited with code " + String(code) + "\n" + output)));
      });
    }).pipe(Effect.timeout("30 seconds")),
    (cli) => Effect.sync(() => cli.kill()),
  );

/** Emit the event until `check` passes: the worker may not have registered the topic yet. */
const emitUntil = (
  emit: () => void,
  check: () => boolean,
  output: () => string,
): Effect.Effect<void, Error> =>
  Effect.suspend(() => {
    if (check()) return Effect.void;
    emit();
    return Effect.fail("pending");
  }).pipe(
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeout("20 seconds"),
    Effect.mapError(() => new Error("OBS state never matched\n" + output())),
  );

describe("ballast run with declared OBS scenes", () => {
  it.live(
    "syncs the declared scene through the agent and drives it from an event",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { obs, server } = yield* startSceneifyObs;
          const cli = yield* startCli(["--connection", "obs/main=" + server.url, "--param", "message=Hello"]);

          const banner = () =>
            obs.snapshot().scenes.find((scene) => scene.name === "Alerts")?.items.find((item) => item.sourceName === "Alert Banner");
          const hype = () =>
            obs.snapshot().inputs.find((input) => input.name === "Camera")?.filters.find((filter) => filter.name === "Hype");
          const sceneChanged = (sceneName: string) => () =>
            server.emit("CurrentProgramSceneChanged", { sceneName, sceneUuid: "uuid-" + sceneName });

          yield* emitUntil(
            sceneChanged("Alerts"),
            () => banner()?.enabled === true && hype()?.enabled === true,
            cli.output,
          );

          const snapshot = obs.snapshot();
          expect(snapshot.inputs.find((input) => input.name === "Alert Banner")?.settings).toMatchObject({ text: "Hello" });
          expect(obs.calls.some((call) => call.requestType === "SetSourcePrivateSettings")).toBe(true);
          expect(obs.calls.some((call) => call.requestType === "SetSceneItemPrivateSettings")).toBe(true);

          // Later events reuse the synced scene rather than reconciling again.
          const creates = obs.calls.filter((call) => call.requestType.startsWith("Create")).length;
          yield* emitUntil(sceneChanged("Other"), () => banner()?.enabled === false, cli.output);
          expect(hype()?.enabled).toBe(false);
          expect(obs.calls.filter((call) => call.requestType.startsWith("Create")).length).toBe(creates);
        }),
      ),
    60_000,
  );
});
