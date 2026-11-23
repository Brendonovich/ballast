import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * Shared resource declarations. The Worker's Effect init binds this database
 * with `Cloudflare.D1.QueryDatabase(BallastDatabase)`, and the stack creates
 * it by yielding the same resource.
 */
const databaseName = process.env.BALLAST_D1_NAME;

export const BallastDatabase = Cloudflare.D1.Database("BallastDatabase", {
  // Remote dev sets a stable, stage-scoped name; local dev/tests keep the
  // generated name so parallel e2e stages cannot collide.
  ...(databaseName === undefined || databaseName === "" ? {} : { name: databaseName }),
  migrations: "./migrations",
});
