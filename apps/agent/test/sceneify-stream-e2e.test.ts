import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { startSceneifyObs } from "./support/sceneify-obs.ts";
import { seedMockTwitchAccount, startMockTwitchServer } from "./support/mock-twitch.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const project = fileURLToPath(new URL("../../../examples/sceneify-stream/ballast.ts", import.meta.url));

const scopes = [
  "user:read:chat",
  "user:write:chat",
  "bits:read",
  "moderator:read:followers",
  "channel:read:subscriptions",
];

const waitUntil = (check: () => boolean, description: string, output: () => string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(new Error("Timed out waiting for " + description + "\n" + output()));
      }
      yield* Effect.sleep("50 millis");
    }
  });

const startCli = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", bin, ...args],
        { cwd: repoRoot, env: { ...process.env, CI: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      return { output: () => output, kill: () => child.kill("SIGTERM") };
    }),
    (cli) => Effect.sync(() => cli.kill()),
  );

const user = { user_id: "9001", user_login: "viewer", user_name: "Viewer" };

const chat = (broadcaster: Record<string, string>, text: string, badges: ReadonlyArray<string>) => ({
  ...broadcaster,
  chatter_user_id: "42",
  chatter_user_login: "mod",
  chatter_user_name: "Mod",
  message_id: "msg-" + Math.random(),
  message: { text, fragments: [{ type: "text", text }] },
  color: "",
  badges: badges.map((set_id) => ({ set_id, id: "1", info: "" })),
  message_type: "text",
});

describe("examples/sceneify-stream", () => {
  it.live(
    "builds the layout in OBS and runs alerts, hype and chat commands from Twitch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "ballast-sceneify-stream-"))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const { obs, server } = yield* startSceneifyObs;
          const twitch = yield* Effect.acquireRelease(
            Effect.promise(() => startMockTwitchServer({ scopes })),
            (mock) => Effect.promise(() => mock.close()),
          );
          yield* Effect.promise(() => seedMockTwitchAccount({ dataDir, slot: "broadcaster", server: twitch }));

          const cli = yield* startCli(
            ["run", project, "--connection", "obs/main=" + server.url, "--twitch-mode", "local"],
            {
              BALLAST_DATA_DIR: dataDir,
              BALLAST_TWITCH_TOKEN_URL: twitch.idBaseUrl + "/oauth2/token",
              BALLAST_TWITCH_VALIDATE_URL: twitch.idBaseUrl + "/oauth2/validate",
              BALLAST_TWITCH_HELIX_URL: twitch.helixBaseUrl,
              BALLAST_TWITCH_EVENTSUB_URL: twitch.eventSubUrl,
            },
          );
          const waitFor = (check: () => boolean, description: string) =>
            waitUntil(check, description, cli.output);

          const state = () => obs.snapshot();
          const scene = (name: string) => state().scenes.find((s) => s.name === name);
          const input = (name: string) => state().inputs.find((i) => i.name === name);
          const item = (sceneName: string, sourceName: string) =>
            scene(sceneName)?.items.find((i) => i.sourceName === sourceName);
          const hype = () => input("Camera")?.filters.find((f) => f.name === "Hype");

          // Startup: every declared scene and shared input exists once.
          yield* waitFor(() => cli.output().includes("OBS layout ready"), "the layout sync");
          expect(state().scenes.map((s) => s.name).sort()).toEqual(
            ["Be Right Back", "Gameplay", "Just Chatting", "Starting Soon"],
          );
          expect(state().inputs.filter((i) => i.name === "Camera")).toHaveLength(1);
          expect(scene("Gameplay")!.items.map((i) => i.sourceName)).toEqual(
            ["Game", "Camera", "Chat", "Stream Title", "Alert Banner"],
          );
          expect(input("Starting Soon Music")?.settings).toMatchObject({
            local_file: "C:\\Stream\\music\\starting-soon.mp3",
            looping: true,
          });
          expect(input("Stream Title")?.settings).toMatchObject({ text: "Building things with Ballast" });
          expect(hype()).toMatchObject({ kind: "color_filter_v2", enabled: false });

          const broadcaster = {
            broadcaster_user_id: twitch.userId,
            broadcaster_user_login: twitch.login,
            broadcaster_user_name: "Streamer",
          };
          const emit = (type: string, event: Record<string, unknown>) =>
            waitFor(() => twitch.emit(type, event), type + " subscription");

          // A follow plays an alert on Gameplay; the video ending cleans it up.
          yield* emit("channel.follow", { ...user, ...broadcaster, followed_at: new Date().toISOString() });
          yield* waitFor(() => item("Gameplay", "Alert 1") !== undefined, "the follow alert");
          expect(input("Alert 1")?.settings).toMatchObject({ local_file: "C:\\Stream\\alerts\\alert.webm" });
          yield* waitFor(
            () =>
              item("Gameplay", "Alert Banner")?.enabled === true &&
              input("Alert Banner")?.settings["text"] === "Viewer followed!",
            "the follow banner",
          );

          server.emit("MediaInputPlaybackEnded", { inputName: "Alert 1", inputUuid: "uuid-alert-1" });
          yield* waitFor(() => item("Gameplay", "Alert 1") === undefined, "the alert cleanup");
          yield* waitFor(() => item("Gameplay", "Alert Banner")?.enabled === false, "the banner to hide");

          // Mod commands switch scenes and set the title; viewers can't.
          yield* emit("channel.chat.message", chat(broadcaster, "!scene chatting", ["moderator"]));
          yield* waitFor(() => state().currentProgramSceneName === "Just Chatting", "!scene chatting");
          yield* emit("channel.chat.message", chat(broadcaster, "!scene brb", []));
          yield* emit("channel.chat.message", chat(broadcaster, "!title Speedrun time", ["broadcaster"]));
          yield* waitFor(() => input("Stream Title")?.settings["text"] === "Speedrun time", "!title");
          expect(state().currentProgramSceneName).toBe("Just Chatting");

          // A big cheer turns on hype mode and alerts on the live scene.
          yield* emit("channel.cheer", { is_anonymous: false, ...user, ...broadcaster, message: "Cheer600", bits: 600 });
          yield* waitFor(() => hype()?.enabled === true, "hype mode");
          yield* waitFor(() => item("Just Chatting", "Alert 2") !== undefined, "the cheer alert");
          yield* waitFor(
            () => input("Alert Banner")?.settings["text"] === "Viewer cheered 600 bits!",
            "the cheer banner",
          );
          expect(item("Gameplay", "Alert 2")).toBeUndefined();
        }),
      ),
    90_000,
  );
});
