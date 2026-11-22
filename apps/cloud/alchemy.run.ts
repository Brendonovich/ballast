import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect } from "effect";

import type { Relay } from "./src/relay/relay-do.ts";

export const BallastDatabase = Cloudflare.D1.Database("BallastDatabase", {
  migrations: "./migrations",
});

export const RelayBinding = Cloudflare.DurableObject<Relay>("Relay", {
  className: "Relay",
});

export const BallastCloudWorker = Cloudflare.Worker("BallastCloudWorker", {
  main: "./src/worker.ts",
  dev: { port: Number(process.env.BALLAST_DEV_PORT ?? "1338"), strictPort: true },
  env: {
    DB: BallastDatabase,
    RELAY: RelayBinding,
    BALLAST_PUBLIC_ORIGIN: Config.String("BALLAST_PUBLIC_ORIGIN").pipe(
      Config.withDefault("http://localhost:1338"),
    ),
    TWITCH_CLIENT_ID: Config.String("TWITCH_CLIENT_ID"),
    TWITCH_CLIENT_SECRET: Config.Redacted("TWITCH_CLIENT_SECRET"),
    BALLAST_TOKEN_KEY: Config.Redacted("BALLAST_TOKEN_KEY"),
    BALLAST_TOKEN_PEPPER: Config.String("BALLAST_TOKEN_PEPPER"),
    BALLAST_TWITCH_MAX_SUBSCRIPTION_COST: Config.String(
      "BALLAST_TWITCH_MAX_SUBSCRIPTION_COST",
    ).pipe(Config.withDefault("10")),
    TWITCH_ID_BASE_URL: Config.String("TWITCH_ID_BASE_URL").pipe(
      Config.withDefault("https://id.twitch.tv"),
    ),
    TWITCH_API_BASE_URL: Config.String("TWITCH_API_BASE_URL").pipe(
      Config.withDefault("https://api.twitch.tv"),
    ),
  },
});

export type CloudEnv = Cloudflare.InferEnv<typeof BallastCloudWorker>;

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
    const worker = yield* BallastCloudWorker;
    return { url: worker.url };
  }),
);
