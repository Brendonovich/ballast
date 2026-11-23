import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect, Schema } from "effect";

const CooldownEnded = Schema.Struct({ user: Schema.String });

export default Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");

  const cooldown = yield* Ballast.Timer.subscribe(
    "cooldown",
    CooldownEnded,
    (fire) =>
      Effect.log(
        `cooldown ended for ${fire.payload.user} (late by ${fire.lateByMs}ms)`,
      ),
    {
      title: "Cooldown",
      // A timer is a promise to run work, so a fire missed while the service
      // was down is delivered late (up to a day) instead of disappearing.
      onStale: "deliver",
      maxAgeMs: 24 * 60 * 60_000,
    },
  );

  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const user = `tick-${tick.n}`;
      // The key is idempotent: a new tick replaces the pending cooldown instead
      // of creating one timer per tick. Restarting the service keeps the last
      // scheduled wake-up.
      yield* cooldown.after("global", "10 minutes", { user });
      yield* Effect.log(`cooldown started for ${user}`);
    }),
  );
});
