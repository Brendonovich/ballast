import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import { BallastCloudWorker } from "./src/cloud-worker.ts";
import { SharesApi, SharesDatabase, makeSharesApiLayer } from "@ballast/shares-api";
import { BallastDatabase } from "./src/resources.ts";
import BallastCloudWorkerLayer from "./src/worker.ts";

const enabled = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());

/**
 * `alchemy dev` is local by default: local state and workerd, so tests and the
 * e2e suite never need a Cloudflare account. `pnpm dev:remote` sets
 * BALLAST_CLOUD_REMOTE_DEV=1; that selects the Cloudflare state store and
 * pins the stack to live providers, which gives the Worker a public workers.dev
 * URL for OAuth redirects and EventSub webhooks. Deploys are always live.
 */
const isDev = enabled(process.env.ALCHEMY_DEV);
const remoteDev = isDev && enabled(process.env.BALLAST_CLOUD_REMOTE_DEV);

// Project sharing runs in the shares API Worker (`@ballast/shares-api`). Local
// workerd only offers Artifacts as a remote binding (credentials needed), so
// local dev leaves sharing off unless BALLAST_SHARES points at the
// simulator bridge (`pnpm shares:bridge`). The shares API reads it as a
// Config during init, which binds the value into its env.
if (isDev && !remoteDev) process.env.BALLAST_SHARES ??= "off";

export default Alchemy.Stack(
  "Ballast",
  {
    providers: Cloudflare.providers(),
    // Remote dev uses a Ballast-owned state store, separate from the shared
    // account store: the installed Alchemy contract must match the store's
    // version, and another project's store may be newer. Local dev stays
    // local; deploys keep the account's default store.
    state: isDev
      ? remoteDev
        ? Cloudflare.state({ name: "ballast" })
        : Alchemy.localState()
      : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (remoteDev && !/^dev[-_]/i.test(stage)) {
      return yield* Effect.die(
        new Error(
          `Remote dev must use a dev-* stage, not "${stage}". Pass --stage dev-<user>.`,
        ),
      );
    }
    const deploy = Effect.gen(function* () {
      yield* BallastDatabase;
      yield* SharesDatabase;
      // Its own dev port, so it never takes the cloud's strict BALLAST_DEV_PORT.
      yield* SharesApi.pipe(
        Effect.provide(
          makeSharesApiLayer({
            devPort: Number(process.env.BALLAST_SHARES_DEV_PORT ?? "1339"),
          }),
        ),
      );
      const worker = yield* BallastCloudWorker.pipe(
        Effect.provide(BallastCloudWorkerLayer),
      );
      return { url: worker.url };
    });

    // `remote()` flips this whole registration scope to live providers during
    // `alchemy dev`, so D1, the Durable Object namespace and the Worker are
    // real Cloudflare resources. The dev supervisor still watches and reapplies.
    return yield* remoteDev ? deploy.pipe(Alchemy.remote()) : deploy;
  }),
);
