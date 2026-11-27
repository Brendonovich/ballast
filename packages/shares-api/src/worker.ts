import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Config, Effect } from "effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { makeSharesApi } from "./api.ts";
import {
  makeArtifactsShareRepos,
  makeBridgeShareRepos,
  type ShareReposService,
} from "./repos.ts";
import { ShareRepoNamespace, SharesApi, SharesDatabase } from "./resources.ts";
import { makeD1ShareStore } from "./store.ts";

export interface SharesApiOptions {
  /** Physical Worker name; defaults to Alchemy's generated name. */
  readonly name?: string;
  /** Preferred `alchemy dev` port (the next free one is used if taken). */
  readonly devPort?: number;
}

/**
 * The shares API runtime. `BALLAST_SHARES` picks repo storage: `artifacts`
 * (default; binds the Artifacts namespace), `off` (sharing answers 503),
 * or the http(s) URL of the local simulator bridge (`scripts/shares-dev`).
 * Alchemy captures the value at plan time, so init takes the same branch at
 * runtime.
 */
export const makeSharesApiLayer = (options: SharesApiOptions = {}) =>
  SharesApi.make(
    {
      main: import.meta.url,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.devPort === undefined ? {} : { dev: { port: options.devPort } }),
    },
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.QueryDatabase(SharesDatabase);
      const store = makeD1ShareStore(yield* database.raw);
      const runtime = yield* RuntimeContext;
      const storage = yield* Config.String("BALLAST_SHARES").pipe(Config.withDefault("artifacts"));
      const repos: ShareReposService | undefined =
        storage === "off"
          ? undefined
          : /^https?:\/\//.test(storage)
            ? makeBridgeShareRepos(storage)
            : makeArtifactsShareRepos(
                yield* Cloudflare.Artifacts.ReadWriteNamespace(yield* ShareRepoNamespace),
                (effect) => effect.pipe(Effect.provideService(RuntimeContext, runtime)),
              );
      return {
        ...makeSharesApi({ store, repos }),
        fetch: Effect.succeed(
          HttpServerResponse.text(JSON.stringify({ ok: true, service: "ballast-shares", storage: repos !== undefined }), {
            contentType: "application/json",
          }),
        ),
      };
    }).pipe(
      Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
      Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding),
      // The Worker platform supplies the real RuntimeContext at plan and runtime.
      Effect.provide(Alchemy.RuntimeContext.phantom),
    ),
  );

const configuredName = process.env.BALLAST_SHARES_WORKER_NAME;
const configuredPort = process.env.BALLAST_SHARES_DEV_PORT;

export default makeSharesApiLayer({
  ...(configuredName === undefined || configuredName === "" ? {} : { name: configuredName }),
  ...(configuredPort === undefined || configuredPort === "" ? {} : { devPort: Number(configuredPort) }),
});
