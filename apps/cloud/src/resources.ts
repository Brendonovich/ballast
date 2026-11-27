import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * Shared resource declarations. The Worker's Effect init binds this database
 * with `Cloudflare.D1.QueryDatabase(BallastDatabase)`, and the stack creates
 * it by yielding the same resource.
 */
export const BallastDatabase = Cloudflare.D1.Database("BallastDatabase", {
  migrations: "./migrations",
});
