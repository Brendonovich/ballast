import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import { SharesApi, SharesDatabase } from "./src/resources.ts";
import SharesApiLayer from "./src/worker.ts";

const enabled = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());

/**
 * The shares API on its own (D1, the Artifacts namespace and the
 * shares API Worker). The Ballast cloud stack includes the same resources and
 * calls the Worker over a service binding; this stack is for deploying or
 * developing the shares API independently. `alchemy dev` is local.
 */
const isDev = enabled(process.env.ALCHEMY_DEV);

// Local workerd only offers Artifacts as a remote binding (credentials
// needed). Local dev uses the wrangler simulator bridge (`pnpm bridge`)
// unless BALLAST_SHARES says otherwise.
if (isDev) process.env.BALLAST_SHARES ??= "http://127.0.0.1:8799";

export default Alchemy.Stack(
  "BallastShares",
  {
    providers: Cloudflare.providers(),
    state: isDev ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* SharesDatabase;
    const api = yield* SharesApi.pipe(Effect.provide(SharesApiLayer));
    return { url: api.url };
  }),
);
