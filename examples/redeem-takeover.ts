import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import * as Workflow from "@ballast/workflow";
import { Effect, Schema } from "effect";

export const title = "Redeem Takeover";

const RedeemPayload = Schema.Struct({
  id: Schema.String,
  broadcaster_id: Schema.String,
  reward_id: Schema.String,
  user_id: Schema.String,
  user_name: Schema.String,
});

/**
 * Redemption takeover:
 *
 *   get the current OBS scene -> wait 30s -> restore the scene -> fulfill
 *
 * Workflow.make registers during init and returns a handle. The body closes
 * over the connection/request values created here. Activities are inline; the
 * engine journals their names and schema hashes at runtime (decision 0007).
 */
export default Effect.gen(function* () {
  const broadcaster = yield* Twitch.Account("broadcaster");
  const obs = yield* OBS.Connection("main");
  const updateRedemption = yield* broadcaster.helix("updateRedemptionStatus");

  const takeover = yield* Workflow.make(
    "redeem-takeover",
    {
      title: "Redeem Takeover",
      payload: RedeemPayload,
      success: Schema.Void,
      error: Schema.Never,
      idempotencyKey: (payload) => payload.id,
    },
    (payload) =>
      Effect.gen(function* () {
        const cancel = Workflow.activity(
          "cancel-redemption",
          Schema.Void,
          updateRedemption({
            broadcaster_id: payload.broadcaster_id,
            reward_id: payload.reward_id,
            id: payload.id,
            status: "CANCELED",
          }).pipe(Effect.asVoid, Effect.orDie),
        );

        yield* Effect.catchCause(
          Effect.gen(function* () {
            const sceneName = yield* Workflow.activity(
              "get-original-scene",
              Schema.String,
              obs
                .GetCurrentProgramScene({})
                .pipe(
                  Effect.map((scene) => scene.currentProgramSceneName),
                  Effect.orDie,
                ),
            );

            yield* Workflow.activity(
              "restore-scene",
              Schema.Void,
              obs
                .SetCurrentProgramScene({ sceneName })
                .pipe(Effect.asVoid, Effect.orDie),
            );

            yield* Workflow.sleep("takeover-hold", "30 seconds");

            yield* Workflow.activity(
              "fulfill-redemption",
              Schema.Void,
              updateRedemption({
                broadcaster_id: payload.broadcaster_id,
                reward_id: payload.reward_id,
                id: payload.id,
                status: "FULFILLED",
              }).pipe(Effect.asVoid, Effect.orDie),
            );

            yield* Effect.log(
              `restored ${sceneName} after ${payload.user_name}'s redemption`,
            );
          }),
          () => cancel,
        );
      }),
  );

  yield* Twitch.ChannelPointsRedemption.subscribe(broadcaster, (event) =>
    Effect.gen(function* () {
      yield* takeover.execute(
        {
          id: event.id,
          broadcaster_id: event.broadcaster_user_id,
          reward_id: event.reward.id,
          user_id: event.user_id,
          user_name: event.user_name,
        },
        { discard: true },
      );
    }),
  );
});
