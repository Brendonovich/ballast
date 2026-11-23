import * as Ballast from "@ballast/core";
import * as Http from "@ballast/module-http";
import * as OBS from "@ballast/module-obs";
import { Effect, Schema } from "effect";

const Donation = Schema.Struct({
  from: Schema.String,
  amount: Schema.Number,
  message: Schema.optional(Schema.String),
});

const Summary = Schema.Struct({ total: Schema.Number });

export default Effect.gen(function* () {
  const hook = yield* Http.Webhook("kofi");
  const api = yield* Http.Client("kofi-api", { hosts: ["api.example.com"] });
  const obs = yield* OBS.Connection("main");
  const scene = yield* Ballast.Param.string("scene", {
    title: "Scene",
    options: OBS.scenes(obs),
  });

  yield* Http.Webhook.json(Donation).subscribe("donation", hook, (donation) =>
    Effect.gen(function* () {
      if (donation.amount <= 0) return;
      const summary = yield* api.get("/v1/summary", { schema: Summary });
      yield* Effect.log(
        "donation from " + donation.from + " for " + donation.amount + " (total " + summary.body.total + ")",
      );
      yield* obs.SetCurrentProgramScene({ sceneName: yield* scene });
    }),
  );
});
