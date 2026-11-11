import {
  Array as Arr,
  Config,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { Kysely, PostgresDialect, type ControlledTransaction, type RawBuilder } from "kysely";
import * as pg from "pg";

import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { DB, User, Organization, Playground, Commit };

/** A query or transaction step failed. `cause` is usually the `pg.DatabaseError`. */
export class DatabaseError extends Schema.TaggedError<
  DatabaseError,
  { readonly brand: unique symbol }
>()("DatabaseError", {
  cause: Schema.Unknown,
}) {}

/** Pass as the `catch` of `Effect.tryPromise` around any Kysely `execute()`. */
export const toDatabaseError = (cause: unknown) => new DatabaseError({ cause });

/** A Kysely query builder, or any value whose `execute()` returns a Promise. */
export type Query<A> = { execute(): Promise<A> };

/** The tables the visitor role reaches: `app_public` only. */
export type PublicDB = Pick<DB, Extract<keyof DB, `app_public.${string}`>>;

/** A connection typed to the tables its role can reach, with the ways to run a query on it. */
export type DbHandle<Schema = DB> = {
  /** The connection to build queries against: the pool, or an open transaction. */
  readonly connection: Kysely<Schema>;
  /** Wraps a raw `sql` template so `all`, `one` and `maybe` run it on this connection. */
  readonly raw: <A>(query: RawBuilder<A>) => Query<ReadonlyArray<A>>;
  /** Runs a query and returns its result. */
  readonly all: <A>(query: Query<A>) => Effect.Effect<A, DatabaseError>;
  /** Runs a query and returns its sole row. No row is a defect: use it where the row must exist. */
  readonly one: <A>(query: Query<ReadonlyArray<A>>) => Effect.Effect<A, DatabaseError>;
  /** Runs a query and returns its first row, if any. */
  readonly maybe: <A>(
    query: Query<ReadonlyArray<A>>,
  ) => Effect.Effect<Option.Option<A>, DatabaseError>;
  /**
   * Runs `use` in one transaction on one pooled connection: it commits when
   * `use` succeeds and rolls back when it fails or is interrupted. Call it on a
   * pool handle only; Kysely cannot start a transaction inside another.
   */
  readonly transaction: <A, E, R>(
    use: (trx: DbHandle<Schema>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>;
};

// Above the pool classes: their static layers call it while the module loads.
const openPool = Effect.fnUntraced(function* <Schema>(urlKey: string) {
  const url = yield* Config.Redacted(urlKey);
  const db = connect<Schema>(Redacted.value(url));
  yield* Effect.addFinalizer(() => Effect.promise(() => db.destroy()));
  return db;
});

/**
 * The authenticator login. Its type holds only `app_public` tables. A query on
 * the pool itself runs as the authenticator role; request code reaches it
 * through `withAuthContext`, which switches each transaction to the visitor role.
 */
export class PgAuthDB extends Context.Service<PgAuthDB, DbHandle<PublicDB>>()("PgAuthDB") {
  static readonly layer = Layer.effect(
    this,
    openPool<PublicDB>("AUTH_DATABASE_URL").pipe(Effect.map(makeHandle)),
  );
}

/**
 * The owning role, which bypasses row-level security. Each `all` runs on the
 * pool and commits on its own; work that must commit or roll back together uses
 * `transaction`. Its connections are not the visitor pool's, so a root write
 * inside a request stays committed when the request's transaction rolls back.
 */
export class PgRootDB extends Context.Service<PgRootDB, DbHandle>()("PgRootDB") {
  static readonly layer = Layer.effect(
    this,
    openPool<DB>("DATABASE_URL").pipe(Effect.map(makeHandle)),
  );
}

export const DatabaseLive = Layer.mergeAll(PgAuthDB.layer, PgRootDB.layer);

function makeHandle<Schema>(kysely: Kysely<Schema>): DbHandle<Schema> {
  const raw = <A>(query: RawBuilder<A>): Query<ReadonlyArray<A>> => ({
    execute: () => query.execute(kysely).then((result) => result.rows),
  });
  const one = <A>(query: Query<ReadonlyArray<A>>) => all(query).pipe(Effect.flatMap(takeOne));
  const maybe = <A>(query: Query<ReadonlyArray<A>>) => all(query).pipe(Effect.map(Arr.head));
  const transaction = <A, E, R>(use: (trx: DbHandle<Schema>) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(startTransaction(kysely), (trx) => use(makeHandle(trx)), settle);
  return { connection: kysely, raw, all, one, maybe, transaction };
}

/** Runs a query and maps its failure to `DatabaseError`. */
// Every query gets its own span. The OTLP tracer exports these, and they stand
// in for the Postgres auto-instrumentation the Node SDK used to provide.
function all<A>(query: Query<A>) {
  return Effect.tryPromise({ try: () => query.execute(), catch: toDatabaseError }).pipe(
    Effect.withSpan("db.query"),
  );
}

const expectedOneRow = new Error("expected one row");

const takeOne = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> =>
  Option.match(Arr.head(rows), {
    onNone: () => Effect.die(expectedOneRow),
    onSome: Effect.succeed,
  });

/**
 * A Kysely instance over a `pg` pool. The pool connects lazily, on the first
 * query. int8 columns arrive as `bigint` rather than strings; the parser is
 * the pool's own, so other pg clients in the process keep their defaults.
 */
function connect<Schema>(connectionString: string): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        types: {
          getTypeParser: (oid, format) =>
            oid === pg.types.builtins.INT8 ? BigInt : pg.types.getTypeParser(oid, format),
        },
      }),
    }),
  });
}

/** Opens a transaction on one pooled connection. */
function startTransaction<Schema>(db: Kysely<Schema>) {
  return Effect.tryPromise({
    try: () => db.startTransaction().execute(),
    catch: toDatabaseError,
  });
}

/**
 * Commits a transaction whose scope succeeded and rolls it back otherwise. A
 * failed rollback leaves the connection in an unknown state, so it is a defect.
 */
function settle<A, E, Schema>(trx: ControlledTransaction<Schema>, exit: Exit.Exit<A, E>) {
  return Exit.isSuccess(exit)
    ? Effect.tryPromise({ try: () => trx.commit().execute(), catch: toDatabaseError })
    : Effect.tryPromise({ try: () => trx.rollback().execute(), catch: toDatabaseError }).pipe(
        Effect.orDie,
      );
}

const CUSTOM_ERROR_CODES: readonly string[] = [
  "LOCKD", // Account/process locked
  "WEAKP", // Weak password
  "LOGIN", // Authentication required
  "DNIED", // Access denied
  "CREDS", // Invalid credentials
  "MODAT", // Missing/mandatory data
  "TAKEN", // Already taken/linked
  "EMTKN", // Email taken
  "CDLEA", // Cannot delete last email address
  "VRFY1", // Verification required (email not verified)
  "VRFY2", // Verification required (user account not verified)
  "ISMBR", // Already a member
  "NTFND", // Not found
  "OWNER", // Organization owner constraint
];

const PgDatabaseError = Schema.instanceOf(pg.DatabaseError);

// A failed query reaches the handlers either as the raw pg error or wrapped in `DatabaseError`.
const PgErrorSource = Schema.Union([
  PgDatabaseError,
  Schema.TaggedStruct("DatabaseError", { cause: PgDatabaseError }),
]);

/**
 * The `pg.DatabaseError` behind a failed query, or `undefined` for any other failure.
 * A non-pg failure is the normal case for most catch sites, so the decode failure is
 * recovered here rather than surfaced.
 */
export const unwrapPgError = (error: unknown) =>
  Schema.decodeUnknownEffect(PgErrorSource)(error).pipe(
    Effect.map((source) => (source instanceof pg.DatabaseError ? source : source.cause)),
    Effect.orElseSucceed((): pg.DatabaseError | undefined => undefined),
  );

/**
 * Maps a failed query to an HTTP status and a message the client may see. A known
 * constraint violation answers 400 with the database's message. Any other failure
 * is logged and answers 500 with `fallbackMessage`.
 */
export const handleDbError = Effect.fnUntraced(function* (cause: unknown, fallbackMessage: string) {
  const dbError = yield* unwrapPgError(cause);
  if (dbError?.code && CUSTOM_ERROR_CODES.includes(dbError.code)) {
    yield* Effect.annotateCurrentSpan("db.error_code", dbError.code);
    return { code: 400, error: dbError.message };
  }
  yield* Effect.logError("Database error", cause);
  return { code: 500, error: fallbackMessage };
});
