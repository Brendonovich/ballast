import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { DatabaseExecuteInput, SqlErrorWire } from "@ballast/core";
import { sqlErrorToWire } from "@ballast/core";

/**
 * The agent-side database host. Each declared database is a SQLite file under
 * `<directory>/<name>.sqlite`, opened lazily with `@effect/sql-sqlite-node`
 * (which uses Node's built-in `node:sqlite`, so there are no native
 * packages). The worker executes SQL through the `DatabaseExecute` runtime
 * RPC; this manager owns the connections and their lifetime.
 */
export interface RunDatabases {
  readonly execute: (
    input: DatabaseExecuteInput,
  ) => Effect.Effect<unknown, SqlErrorWire>;
  readonly close: Effect.Effect<void>;
}

const runStatement = (
  client: Client.SqlClient,
  input: DatabaseExecuteInput,
): Effect.Effect<unknown, SqlErrorWire> =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* client.reserve;
      switch (input.method) {
        case "execute":
          return yield* connection.execute(input.sql, input.params, undefined);
        case "executeRaw":
          return yield* connection.executeRaw(input.sql, input.params);
        case "executeValues":
          return yield* connection.executeValues(input.sql, input.params);
        case "executeValuesUnprepared":
          return yield* connection.executeValuesUnprepared(input.sql, input.params);
        case "executeUnprepared":
          return yield* connection.executeUnprepared(
            input.sql,
            input.params,
            undefined,
          );
      }
    }),
  ).pipe(Effect.mapError(sqlErrorToWire));

/**
 * Open a per-name SQLite host for the lifetime of a run or a project
 * generation. `close` releases the files; a hot reload drops the old
 * generation's connections and the new worker reopens them on first use.
 */
export const startRunDatabases = (
  directory: string,
): Effect.Effect<RunDatabases, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parent = yield* Scope.Scope;
    const scope = yield* Scope.fork(parent, "parallel");
    // node:sqlite requires the parent directory to exist before it can open.
    yield* Effect.sync(() => mkdirSync(directory, { recursive: true }));
    const clients = new Map<string, Effect.Effect<Client.SqlClient, SqlError>>();

    const open = (name: string): Effect.Effect<Client.SqlClient, SqlError> => {
      const existing = clients.get(name);
      if (existing !== undefined) return existing;
      const effect = SqliteClient.make({
        filename: join(directory, name + ".sqlite"),
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Reactivity.layer),
      );
      clients.set(name, effect);
      return effect;
    };

    return {
      execute: (input) =>
        open(input.name).pipe(
          Effect.mapError(sqlErrorToWire),
          Effect.flatMap((client) => runStatement(client, input)),
        ),
      close: Scope.close(scope, Exit.void),
    };
  });
