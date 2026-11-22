import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import { BallastCloudWorker } from "./src/cloud-worker.ts";
import { BallastDatabase } from "./src/resources.ts";
import BallastCloudWorkerLayer from "./src/worker.ts";

/**
 * `alchemy dev` must run without a Cloudflare account, so it keeps state in
 * `.alchemy/state` on disk. Deploys still use the Cloudflare state-store Worker.
 * The CLI sets ALCHEMY_DEV=true on the process that evaluates this stack.
 */
const isDev = ["1", "true", "yes", "on"].includes(
  (process.env.ALCHEMY_DEV ?? "").toLowerCase(),
);

export default Alchemy.Stack(
  "Ballast",
  {
    providers: Cloudflare.providers(),
    state: isDev ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* BallastDatabase;
    const worker = yield* BallastCloudWorker.pipe(
      Effect.provide(BallastCloudWorkerLayer),
    );
    return { url: worker.url };
  }),
);
