// Twitch events and chat commands, wired to the stage.
import * as Ballast from "@ballast/core";
import * as Twitch from "@ballast/module-twitch";
import { Duration, Effect, Schema } from "effect";
import type { Params } from "../ballast.ts";
import { isSceneKey, logFailure, sceneKeys, type Stage } from "./stage.ts";

const tiers = { "1000": "tier 1", "2000": "tier 2", "3000": "tier 3" } as const;

const isMod = (badges: ReadonlyArray<{ readonly set_id: string }>) =>
  badges.some((badge) => badge.set_id === "broadcaster" || badge.set_id === "moderator");

export const wireTwitch = (broadcaster: Twitch.TwitchAccount, stage: Stage, params: Params) =>
  Effect.gen(function* () {
    const sendChat = yield* broadcaster.helix("sendChatMessage");

    const alert = (headline: string, video = params.alertVideo) =>
      Effect.gen(function* () {
        yield* stage.playAlert({ video: yield* video, volumeDb: yield* params.alertVolumeDb, headline });
      });

    // Durable: a restart mid-hype still turns the filter off on time.
    const hypeOff = yield* Ballast.Timer.subscribe(
      "hype-off",
      Schema.Struct({}),
      () => logFailure("hype off", stage.setHype(false)),
      { title: "End hype mode", onStale: "deliver", maxAgeMs: 3_600_000 },
    );

    const hype = Effect.gen(function* () {
      yield* stage.setHype(true);
      yield* hypeOff.after("hype", Duration.minutes(yield* params.hypeMinutes), {});
    });

    // Durable too: Starting Soon hands over to Gameplay even across a restart.
    const goLive = yield* Ballast.Timer.subscribe(
      "go-live",
      Schema.Struct({}),
      () => logFailure("go live", stage.show("gameplay")),
      { title: "Leave Starting Soon", onStale: "deliver", maxAgeMs: 600_000 },
    );

    yield* Twitch.StreamOnline.subscribe("stream-online", broadcaster, () =>
      logFailure(
        "stream online",
        Effect.gen(function* () {
          yield* stage.show("starting");
          yield* goLive.after("live", Duration.minutes(yield* params.startingSoonMinutes), {});
        }),
      ),
    );

    yield* Twitch.Follow.subscribe("follow", broadcaster, (event) =>
      logFailure("follow alert", alert(event.user_name + " followed!")),
    );

    yield* Twitch.Subscribe.subscribe("subscribe", broadcaster, (event) =>
      logFailure(
        "sub alert",
        alert(event.user_name + (event.is_gift ? " got a gifted " : " subscribed at ") + tiers[event.tier] + "!"),
      ),
    );

    yield* Twitch.Cheer.subscribe("cheer", broadcaster, (event) =>
      logFailure(
        "cheer alert",
        Effect.gen(function* () {
          if (event.bits >= (yield* params.hypeBits)) yield* hype;
          yield* alert((event.user_name ?? "Anonymous") + " cheered " + event.bits + " bits!");
        }),
      ),
    );

    yield* Twitch.Raid.subscribe("raid", broadcaster, (event) =>
      logFailure(
        "raid alert",
        alert(event.from_broadcaster_user_name + " raided with " + event.viewers + " viewers!", params.raidVideo),
      ),
    );

    // Mod commands: !scene <name>, !title <text>, !hype, !alert <text>
    yield* Twitch.ChatMessage.subscribe("chat-commands", broadcaster, (event) =>
      Effect.gen(function* () {
        const text = event.message.text.trim();
        if (!text.startsWith("!") || !isMod(event.badges)) return;
        const [command = "", ...rest] = text.slice(1).split(" ");
        const argument = rest.join(" ").trim();

        const reply = (message: string) =>
          sendChat({
            broadcaster_id: event.broadcaster_user_id,
            sender_id: event.broadcaster_user_id,
            message,
            reply_parent_message_id: event.message_id,
          }).pipe(Effect.asVoid);

        switch (command) {
          case "scene":
            if (!isSceneKey(argument)) return yield* reply("Scenes: " + sceneKeys.join(", "));
            return yield* logFailure("!scene", stage.show(argument));
          case "title":
            return yield* logFailure("!title", stage.setTitle(argument));
          case "hype":
            return yield* logFailure("!hype", hype);
          case "alert":
            return yield* logFailure("!alert", alert(argument || "Test alert"));
        }
      }),
    );
  });
