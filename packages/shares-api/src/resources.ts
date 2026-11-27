import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

import type { SharesApiRpc } from "./api.ts";

const migrationsDir = decodeURIComponent(new URL("../migrations", import.meta.url).pathname);
const databaseName = process.env.BALLAST_SHARES_D1_NAME;

/**
 * The shares API's D1 database (shares and subscriptions).
 * Migrations resolve next to this package, so any stack can include it.
 */
export const SharesDatabase = Cloudflare.D1.Database("SharesDatabase", {
  ...(databaseName === undefined || databaseName === "" ? {} : { name: databaseName }),
  migrations: migrationsDir,
});

/**
 * One Artifacts git repo per share. Namespaces are implicit, so this
 * is a binding marker; it is stage-scoped so dev stages never share repos
 * with a deploy.
 */
export const ShareRepoNamespace = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  return yield* Cloudflare.Artifacts.Namespace("ProjectShares", {
    namespace: ("ballast-shares-" + stage).slice(0, 63),
  });
});

/**
 * The shares API Worker. Its methods ({@link SharesApiRpc}) are
 * called over a service binding (`Cloudflare.Workers.bindWorker`); it has
 * no public API beyond `/health`. `src/worker.ts` provides the runtime with
 * `makeSharesApiLayer`, so a consumer can bind the class without
 * bundling the implementation.
 */
export class SharesApi extends Cloudflare.Worker<SharesApi, SharesApiRpc>()(
  "SharesApi",
) {}
