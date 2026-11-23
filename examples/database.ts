import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const db = yield* Ballast.Database("main");

  // Schema creation is the script's own business: run it once before the
  // first event is handled. `db.client` requires Runtime, so it lives here.
  yield* Ballast.run("db-init", Effect.gen(function* () {
    const sql = yield* db.client;
    yield* sql`CREATE TABLE IF NOT EXISTS ticks (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)`;
    yield* Effect.log("database table ready");
  }).pipe(Effect.catchTag("SqlError", (error) => Effect.logError("database init failed", error))));

  const fake = yield* Fake.Connection("main");

  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const sql = yield* db.client;
      yield* sql`INSERT OR REPLACE INTO ticks (n, at) VALUES (${tick.n}, ${Date.now()})`;
      const rows = yield* sql`SELECT COUNT(*) AS count FROM ticks`;
      yield* Effect.log(`ticks count: ${String(rows[0]?.["count"])}`);
    }).pipe(Effect.catchTag("SqlError", (error) => Effect.logError("tick sql failed", error))),
  );
}) satisfies Ballast.Project;
