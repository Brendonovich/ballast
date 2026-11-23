import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  SerializationError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError,
} from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import type { DatabaseManifest } from "./manifest.ts";
import { Runtime } from "./runtime.ts";
import { ManifestRecorder } from "./services.ts";
import { captureSource } from "./source.ts";
import type { DeclarationSource } from "./source.ts";

/**
 * A named local SQLite database. Declared in init; every read/write goes
 * through the effect/sql `SqlClient` yielded by `client`, which requires
 * `Ballast.Runtime` so it cannot run during init. Schema setup (for example
 * `CREATE TABLE IF NOT EXISTS`) is the script's own business, done in
 * `Ballast.run` or a handler.
 */
export interface Database {
  readonly name: string;
  /**
   * Yield the effect/sql SqlClient for this database. The client is opened by
   * the runtime host; the same instance is shared for the worker's lifetime.
   * Requires `Runtime`, so reading it during init is a type error and the
   * plan handle's client dies with `DatabaseCalledDuringPlanError`.
   */
  readonly client: Effect.Effect<Client.SqlClient, SqlError, Runtime>;
}

export class DatabaseCalledDuringPlanError extends Error {
  readonly database: string;

  constructor(database: string) {
    super(
      `Database "${database}" was read during plan. Init must declare databases; handlers and Ballast.run run SQL.`,
    );
    this.name = "DatabaseCalledDuringPlanError";
    this.database = database;
  }
}

export class DatabaseDeclarationError extends Error {
  readonly database: string;

  constructor(database: string, message: string) {
    super(`Database "${database}": ${message}`);
    this.name = "DatabaseDeclarationError";
    this.database = database;
  }
}

const DATABASE_NAME = /^[a-zA-Z0-9_-]+$/;

const validateDatabaseName = (name: string): void => {
  if (name.length === 0) {
    throw new DatabaseDeclarationError(name, "name must be non-empty");
  }
  if (!DATABASE_NAME.test(name)) {
    throw new DatabaseDeclarationError(
      name,
      `name may only contain letters, digits, "_" and "-"`,
    );
  }
};

export interface DatabaseSpec {
  readonly name: string;
  readonly source: DeclarationSource | undefined;
}

export interface DatabaseHostService {
  readonly declare: (spec: DatabaseSpec) => Effect.Effect<Database>;
}

/**
 * The host service databases are declared through. Plan records the name into
 * the manifest and hands back a handle whose client dies; runtime returns a
 * handle backed by the worker-provided `DatabaseRuntime`.
 */
export class DatabaseHost extends Context.Service<DatabaseHost, DatabaseHostService>()(
  "Ballast/DatabaseHost",
) {}

const toManifest = (
  name: string,
  source: DeclarationSource | undefined,
): DatabaseManifest => ({
  name,
  ...(source === undefined ? {} : { source }),
});

const planDatabase = (name: string): Database => ({
  name,
  client: Effect.die(new DatabaseCalledDuringPlanError(name)),
});

/** Plan-phase host: records the declaration and never opens a file. */
export const DatabaseHostPlan: Layer.Layer<DatabaseHost> = Layer.effect(
  DatabaseHost,
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(ManifestRecorder);

    return DatabaseHost.of({
      declare: (spec) =>
        Effect.gen(function* () {
          validateDatabaseName(spec.name);
          yield* Option.match(recorder, {
            onNone: () =>
              Effect.die(
                new Error(
                  `Database "${spec.name}" was declared in plan without a ManifestRecorder`,
                ),
              ),
            onSome: (service) => service.database(toManifest(spec.name, spec.source)),
          });
          return planDatabase(spec.name);
        }),
    });
  }),
);

const getDatabaseClient = (
  name: string,
): Effect.Effect<Client.SqlClient, SqlError, Runtime> =>
  Effect.gen(function* () {
    yield* Runtime;
    const runtime = yield* Effect.serviceOption(DatabaseRuntime);
    return yield* Option.match(runtime, {
      onNone: () =>
        Effect.die(
          new Error(
            `Database "${name}" was used without a DatabaseRuntime service; the runtime worker must provide one`,
          ),
        ),
      onSome: (service) => service.open(name),
    });
  });

const runtimeDatabase = (name: string): Database => ({
  name,
  client: getDatabaseClient(name),
});

/** Runtime host: resolves the client from the worker's `DatabaseRuntime`. */
export const DatabaseHostRuntime: Layer.Layer<DatabaseHost> = Layer.effect(
  DatabaseHost,
  Effect.gen(function* () {
    return DatabaseHost.of({
      declare: (spec) =>
        Effect.sync(() => {
          validateDatabaseName(spec.name);
          return runtimeDatabase(spec.name);
        }),
    });
  }),
);

/**
 * Declare a named local SQLite database. Yields a handle; run SQL with
 * `yield* db.client` in handlers, `Ballast.run` or timer handlers.
 *
 * ```ts
 * const db = yield* Ballast.Database("main");
 * yield* Ballast.run("init", Effect.gen(function* () {
 *   const sql = yield* db.client;
 *   yield* sql`CREATE TABLE IF NOT EXISTS ticks (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)`;
 * }));
 * ```
 */
export const Database = (
  name: string,
): Effect.Effect<Database, never, DatabaseHost> => {
  const source = captureSource(2);
  return Effect.flatMap(DatabaseHost, (host) => host.declare({ name, source }));
};

export interface DatabaseRuntimeService {
  /**
   * Open (or reuse) the effect/sql SqlClient for a declared database. The
   * client is scoped to the host-provided scope passed to
   * `makeDatabaseRuntime`.
   */
  readonly open: (name: string) => Effect.Effect<Client.SqlClient, SqlError>;
}

/**
 * The runtime side of databases, provided by the script worker. The worker
 * builds it from the agent's `DatabaseExecute` RPC, so a script's SQL runs
 * against the agent's SQLite connection.
 */
export class DatabaseRuntime extends Context.Service<DatabaseRuntime, DatabaseRuntimeService>()(
  "Ballast/DatabaseRuntime",
) {}

export interface DatabaseExecuteInput {
  readonly name: string;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly method:
    | "execute"
    | "executeRaw"
    | "executeValues"
    | "executeValuesUnprepared"
    | "executeUnprepared";
}

export type DatabaseExecutor = (
  input: DatabaseExecuteInput,
) => Effect.Effect<unknown, SqlError>;

/** Wire schema for a SqlError that crossed the worker/agent RPC boundary. */
export const SqlErrorWireSchema = Schema.Struct({
  reason: Schema.Struct({
    _tag: Schema.String,
    message: Schema.optional(Schema.String),
    operation: Schema.optional(Schema.String),
    constraint: Schema.optional(Schema.String),
  }),
});
export type SqlErrorWire = Schema.Schema.Type<typeof SqlErrorWireSchema>;

/** Encode a typed SqlError into the JSON-safe wire form. */
export const sqlErrorToWire = (error: SqlError): SqlErrorWire => {
  const reason = error.reason;
  const message = reason.message === undefined ? undefined : reason.message;
  const operation = reason.operation === undefined ? undefined : reason.operation;
  const constraint =
    "constraint" in reason && typeof reason.constraint === "string"
      ? reason.constraint
      : undefined;
  return {
    reason: {
      _tag: reason._tag,
      ...(message === undefined ? {} : { message }),
      ...(operation === undefined ? {} : { operation }),
      ...(constraint === undefined ? {} : { constraint }),
    },
  };
};

const reasonFromWire = (
  wire: SqlErrorWire["reason"],
): SqlError["reason"] => {
  const base = {
    cause: new Error(wire.message ?? wire._tag),
    ...(wire.message === undefined ? {} : { message: wire.message }),
    ...(wire.operation === undefined ? {} : { operation: wire.operation }),
  };
  switch (wire._tag) {
    case "ConnectionError":
      return new ConnectionError(base);
    case "AuthenticationError":
      return new AuthenticationError(base);
    case "AuthorizationError":
      return new AuthorizationError(base);
    case "SqlSyntaxError":
      return new SqlSyntaxError(base);
    case "UniqueViolation":
      return new UniqueViolation({ ...base, constraint: wire.constraint ?? "" });
    case "ConstraintError":
      return new ConstraintError(base);
    case "DeadlockError":
      return new DeadlockError(base);
    case "SerializationError":
      return new SerializationError(base);
    case "LockTimeoutError":
      return new LockTimeoutError(base);
    case "StatementTimeoutError":
      return new StatementTimeoutError(base);
    default:
      return new UnknownError(base);
  }
};

/** Reconstruct a typed SqlError from the wire form received over RPC. */
export const sqlErrorFromWire = (wire: SqlErrorWire): SqlError =>
  new SqlError({ reason: reasonFromWire(wire.reason) });

const makeProxyConnection = (
  exec: DatabaseExecutor,
  name: string,
): SqlConnection.Connection => ({
  execute: (sql, params, _transformRows) =>
    Effect.map(exec({ name, sql, params, method: "execute" }), (rows) =>
      rows as ReadonlyArray<any>,
    ),
  executeRaw: (sql, params) =>
    exec({ name, sql, params, method: "executeRaw" }),
  executeStream: (_sql, _params, _transformRows) =>
    Stream.die(
      "SQL streaming is not supported through Ballast's database transport",
    ),
  executeValues: (sql, params) =>
    Effect.map(exec({ name, sql, params, method: "executeValues" }), (rows) =>
      rows as ReadonlyArray<ReadonlyArray<unknown>>,
    ),
  executeValuesUnprepared: (sql, params) =>
    Effect.map(
      exec({ name, sql, params, method: "executeValuesUnprepared" }),
      (rows) => rows as ReadonlyArray<ReadonlyArray<unknown>>,
    ),
  executeUnprepared: (sql, params, _transformRows) =>
    Effect.map(exec({ name, sql, params, method: "executeUnprepared" }), (rows) =>
      rows as ReadonlyArray<any>,
    ),
});

const makeClient = (
  exec: DatabaseExecutor,
  name: string,
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope> =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const connection = makeProxyConnection(exec, name);
    const acquirers = Client.makeSqliteAcquirers({
      connection: Effect.succeed(connection),
      semaphore,
    });
    return yield* Client.make({
      driver: "ballast-sqlite",
      acquirer: acquirers.acquirer,
      borrower: acquirers.borrower,
      compiler: Statement.makeCompilerSqlite(),
      transactionAcquirer: acquirers.transactionAcquirer,
      onCommitFailure: acquirers.onCommitFailure,
      isTransaction: acquirers.isTransaction,
      beginTransaction: "BEGIN IMMEDIATE",
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  }).pipe(Effect.provide(Reactivity.layer));

/**
 * Build the worker's `DatabaseRuntime` from the agent-provided SQL executor.
 * One `SqlClient` is opened per database name and cached for the lifetime of
 * `scope` (the worker's scope), so it closes cleanly on hot reload.
 */
export const makeDatabaseRuntime = (
  exec: DatabaseExecutor,
  scope: Scope.Scope,
): DatabaseRuntimeService => {
  const clients = new Map<string, Effect.Effect<Client.SqlClient, SqlError>>();
  const open = (name: string): Effect.Effect<Client.SqlClient, SqlError> => {
    const cached = clients.get(name);
    if (cached !== undefined) return cached;
    const effect = makeClient(exec, name).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    clients.set(name, effect);
    return effect;
  };
  return DatabaseRuntime.of({ open });
};
