import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { readStoredTwitchAccount } from "../src/twitch/config.ts";
import { startMockObsServer } from "./mock-obs-server.ts";
import { startMockCloudServer } from "./support/mock-cloud.ts";
import { seedMockTwitchAccount, startMockTwitchServer } from "./support/mock-twitch.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(new URL("../../../examples/redeem-to-scene.ts", import.meta.url));

interface CliHandle {
  readonly output: () => string;
  readonly exitCode: () => number | undefined;
  readonly waitFor: (marker: string) => Effect.Effect<void, Error>;
  readonly stop: Effect.Effect<void>;
}

const startCli = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<CliHandle, Error> =>
  Effect.sync(() => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        bin,
        ...args,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, CI: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let code: number | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (value) => {
      code = value ?? -1;
    });

    const waitFor = (marker: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const deadline = Date.now() + 20_000;
        while (!output.includes(marker)) {
          if (code !== undefined) {
            return yield* Effect.fail(
              new Error(
                "CLI exited with code " + code + " before matching " + JSON.stringify(marker) + "\n" + output,
              ),
            );
          }
          if (Date.now() > deadline) {
            return yield* Effect.fail(
              new Error("Timed out waiting for " + JSON.stringify(marker) + "\n" + output),
            );
          }
          yield* Effect.sleep("50 millis");
        }
      });

    return {
      output: () => output,
      exitCode: () => code,
      waitFor,
      stop: Effect.sync(() => {
        child.kill("SIGTERM");
      }),
    };
  });

const runCliToExit = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): Effect.Effect<{ readonly output: string; readonly code: number }, Error> =>
  Effect.gen(function* () {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        bin,
        ...args,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, CI: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return yield* Effect.callback<{ output: string; code: number }, Error>((resume) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("exit", (code) => {
        resume(Effect.succeed({ output, code: code ?? -1 }));
      });
      return Effect.sync(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      });
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    );
  });

const waitUntil = (
  check: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(new Error("Timed out waiting for " + description));
      }
      yield* Effect.sleep("50 millis");
    }
  });

const withDataDir = <A, E, R>(
  use: (dataDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const dataDir = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "ballast-twitch-")),
      catch: (cause) => new Error(String(cause)),
    });
    return yield* use(dataDir).pipe(
      Effect.ensuring(
        Effect.promise(() => rm(dataDir, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
      ),
    );
  });

const runArgs = (obsUrl: string, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "run",
  example,
  "--param",
  "rewardTitle=Hydrate",
  "--param",
  "scene=Scene 2",
  "--connection",
  "obs/main=" + obsUrl,
  ...extra,
];

const localEnv = (server: Awaited<ReturnType<typeof startMockTwitchServer>>): Record<string, string> => ({
  BALLAST_TWITCH_TOKEN_URL: server.idBaseUrl + "/oauth2/token",
  BALLAST_TWITCH_VALIDATE_URL: server.idBaseUrl + "/oauth2/validate",
  BALLAST_TWITCH_HELIX_URL: server.helixBaseUrl,
  BALLAST_TWITCH_EVENTSUB_URL: server.eventSubUrl,
});

describe("Twitch local-app end to end", () => {
  it.live(
    "a matching redemption sets the OBS scene and a different title does nothing",
    () =>
      Effect.scoped(
        withDataDir((dataDir) =>
          Effect.gen(function* () {
            const obs = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockObsServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            const twitch = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockTwitchServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            yield* Effect.tryPromise({
              try: () =>
                seedMockTwitchAccount({ dataDir, slot: "broadcaster", server: twitch }),
              catch: (cause) => new Error(String(cause)),
            });

            const cli = yield* startCli(runArgs(obs.url, ["--twitch-mode", "local"]), {
              ...localEnv(twitch),
              BALLAST_DATA_DIR: dataDir,
            });
            yield* Effect.addFinalizer(() => cli.stop);

            yield* cli.waitFor("[obs:main] connected");
            yield* cli.waitFor("[twitch:broadcaster] subscribed channel.channel_points_custom_reward_redemption.add");
            yield* waitUntil(
              () =>
                twitch
                  .createdSubscriptions()
                  .some(
                    (subscription) =>
                      subscription.type ===
                      "channel.channel_points_custom_reward_redemption.add",
                  ),
              "the mock EventSub subscription",
            );

            expect(twitch.createdSubscriptions()[0]?.condition).toEqual({
              broadcaster_user_id: twitch.userId,
            });

            expect(twitch.emitRedemption({ title: "Someone else" })).toBe(true);
            yield* cli.waitFor("[twitch:broadcaster] event twitch/channel.channel_points_custom_reward_redemption.add");
            yield* Effect.sleep("500 millis");
            expect(obs.currentScene()).toBe("Scene 1");

            expect(twitch.emitRedemption({ title: "Hydrate" })).toBe(true);
            yield* waitUntil(
              () => obs.currentScene() === "Scene 2",
              "OBS to switch to Scene 2",
            );
            expect(obs.requests()).toContain("SetCurrentProgramScene");
          }),
        ),
      ),
    45_000,
  );

  it.live(
    "refuses to run when the stored token lacks a required scope",
    () =>
      Effect.scoped(
        withDataDir((dataDir) =>
          Effect.gen(function* () {
            const obs = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockObsServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            const twitch = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockTwitchServer({ scopes: [] }),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            yield* Effect.tryPromise({
              try: () =>
                seedMockTwitchAccount({ dataDir, slot: "broadcaster", server: twitch }),
              catch: (cause) => new Error(String(cause)),
            });

            const result = yield* runCliToExit(runArgs(obs.url, ["--twitch-mode", "local"]), {
              ...localEnv(twitch),
              BALLAST_DATA_DIR: dataDir,
            });

            expect(result.code).toBe(1);
            expect(result.output).toContain("missing scopes: channel:read:redemptions");
          }),
        ),
      ),
    45_000,
  );
});

describe("ballast auth twitch", () => {
  it.live(
    "runs the device-code flow and stores the refresh token",
    () =>
      Effect.scoped(
        withDataDir((dataDir) =>
          Effect.gen(function* () {
            const twitch = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockTwitchServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );

            const result = yield* runCliToExit(
              [
                "auth",
                "twitch",
                "broadcaster",
                "--device",
                "--no-open",
                "--scopes",
                "channel:read:redemptions",
                "--connection",
                "twitch/broadcaster=" + twitch.clientId,
                "--connection-secret",
                "twitch/broadcaster=" + twitch.clientSecret,
              ],
              {
                BALLAST_DATA_DIR: dataDir,
                BALLAST_TWITCH_TOKEN_URL: twitch.idBaseUrl + "/oauth2/token",
                BALLAST_TWITCH_DEVICE_URL: twitch.idBaseUrl + "/oauth2/device",
                BALLAST_TWITCH_VALIDATE_URL: twitch.idBaseUrl + "/oauth2/validate",
              },
            );

            expect(result.code).toBe(0);
            expect(result.output).toContain("authorized as streamer (1337");

            const stored = yield* readStoredTwitchAccount("broadcaster", dataDir).pipe(
              Effect.provide(NodeServices.layer),
              Effect.mapError((cause) => new Error(String(cause))),
            );
            expect(stored).toMatchObject({
              slot: "broadcaster",
              clientId: twitch.clientId,
              refreshToken: "mock-refresh-token",
              userId: "1337",
              login: "streamer",
            });
            expect(stored?.scopes).toEqual(
              expect.arrayContaining(["channel:read:redemptions"]),
            );
            expect(twitch.tokenRequests().length).toBeGreaterThan(0);
          }),
        ),
      ),
    45_000,
  );
});

describe("Twitch cloud mode end to end", () => {
  it.live(
    "reports missing scopes from the cloud token",
    () =>
      Effect.scoped(
        withDataDir((dataDir) =>
          Effect.gen(function* () {
            const obs = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockObsServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            const cloud = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockCloudServer({ scopes: [] }),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );

            const pairing = yield* runCliToExit(
              ["pair", "ABC123", "--cloud", cloud.url],
              { BALLAST_DATA_DIR: dataDir },
            );
            expect(pairing.code).toBe(0);

            const result = yield* runCliToExit(runArgs(obs.url, ["--twitch-mode", "cloud"]), {
              BALLAST_DATA_DIR: dataDir,
            });
            expect(result.code).toBe(1);
            expect(result.output).toContain("missing scopes: channel:read:redemptions");
          }),
        ),
      ),
    45_000,
  );

  it.live(
    "pairs, reconciles subscriptions, delivers a relayed redemption and acks it",
    () =>
      Effect.scoped(
        withDataDir((dataDir) =>
          Effect.gen(function* () {
            const obs = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockObsServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );
            const cloud = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => startMockCloudServer(),
                catch: (cause) => new Error(String(cause)),
              }),
              (server) => Effect.promise(() => server.close()),
            );

            const pairing = yield* runCliToExit(
              ["pair", "ABC123", "--cloud", cloud.url, "--machine-name", "test"],
              { BALLAST_DATA_DIR: dataDir },
            );
            expect(pairing.code).toBe(0);
            expect(pairing.output).toContain("paired as streamer");

            const cli = yield* startCli(runArgs(obs.url, ["--twitch-mode", "cloud"]), {
              BALLAST_DATA_DIR: dataDir,
            });
            yield* Effect.addFinalizer(() => cli.stop);

            yield* cli.waitFor("[twitch:cloud] relay connected");
            yield* cli.waitFor("[twitch:broadcaster] subscribed channel.channel_points_custom_reward_redemption.add");
            yield* waitUntil(
              () => cloud.reconciled().length > 0,
              "the cloud reconcile call",
            );

            expect(cloud.reconciled()[0]?.connectionId).toBe(cloud.connectionId);
            expect(cloud.reconciled()[0]?.subscriptions[0]).toMatchObject({
              type: "channel.channel_points_custom_reward_redemption.add",
              condition: { broadcaster_user_id: cloud.twitchUserId },
              onStale: "drop",
              maxAgeMs: 60_000,
            });

            expect(cloud.emitRedemption("Someone else")).toBe(true);
            yield* cli.waitFor("[twitch:broadcaster] event twitch/channel.channel_points_custom_reward_redemption.add");
            yield* Effect.sleep("500 millis");
            expect(obs.currentScene()).toBe("Scene 1");
            yield* waitUntil(() => cloud.acks().length >= 1, "the first relay ack");

            // Drop the relay, queue a matching redemption while disconnected,
            // and let reconnect + replay deliver it.
            cloud.dropRelay();
            yield* Effect.sleep("100 millis");
            expect(cloud.emitRedemption("Hydrate")).toBe(true);
            yield* waitUntil(
              () => obs.currentScene() === "Scene 2",
              "OBS to switch to Scene 2 after relay replay",
            );
            yield* waitUntil(
              () => cloud.relayConnections() >= 2,
              "the relay to reconnect",
            );
            yield* waitUntil(() => cloud.acks().length >= 2, "the replayed relay ack");
          }),
        ),
      ),
    45_000,
  );
});
