import {
  Config,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { Kysely, PostgresDialect, sql, type ControlledTransaction } from "kysely";
import * as pg from "pg";

import { CurrentSession } from "../shared/session.js";
import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { DB, User, Organization, Playground, Commit };

export type KyselyDB = Kysely<DB>;

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

/** Something a boundary can run: an Effect, or a query that the boundary executes. */
export type Step<A, E = never, R = never> = Effect.Effect<A, E, R> | Query<A>;

/** Runs a query and maps its failure to `DatabaseError`. */
// Every query gets its own span. The OTLP tracer exports these, and they stand
// in for the Postgres auto-instrumentation the Node SDK used to provide.
export const runQuery = <A>(query: Query<A>) =>
  Effect.tryPromise({ try: () => query.execute(), catch: toDatabaseError }).pipe(
    Effect.withSpan("db.query"),
  );

const toEffect = <A, E, R>(step: Step<A, E, R>): Effect.Effect<A, E | DatabaseError, R> =>
  Effect.isEffect(step) ? step : runQuery(step);

/**
 * A Kysely instance over a `pg` pool. The pool connects lazily, on the first
 * query. int8 columns arrive as `bigint` rather than strings; the parser is
 * the pool's own, so other pg clients in the process keep their defaults.
 */
const connect = (connectionString: string): KyselyDB =>
  new Kysely<DB>({
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

/**
 * Runs `use` in one transaction on one pooled connection. The transaction
 * commits when `use` succeeds and rolls back when it fails or is interrupted.
 */
const startTransaction = (db: KyselyDB) =>
  Effect.tryPromise({ try: () => db.startTransaction().execute(), catch: toDatabaseError });

/**
 * Commits a transaction whose scope succeeded and rolls it back otherwise. A
 * failed rollback leaves the connection in an unknown state, so it is a defect.
 */
const settle = <A, E>(trx: ControlledTransaction<DB>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Effect.tryPromise({ try: () => trx.commit().execute(), catch: toDatabaseError })
    : Effect.tryPromise({
        try: () => trx.rollback().execute(),
        catch: toDatabaseError,
      }).pipe(Effect.orDie);

/**
 * Runs `use` in one transaction on one pooled connection. The transaction
 * commits when `use` succeeds and rolls back when it fails or is interrupted.
 */
const transact = <A, E, R>(db: KyselyDB, use: (trx: KyselyDB) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(startTransaction(db), use, settle);

/**
 * Binds the visitor role and the session for RLS. Both are transaction-local.
 * A session-local role would outlive the request on a pooled connection and
 * leak one visitor's identity into the next request that reuses it.
 */
const bindVisitor = (trx: KyselyDB, role: string, sessionId: string | undefined) =>
  Effect.tryPromise({
    try: () =>
      sql`select set_config('role', ${role}, true),
                 set_config('my.session_id', ${sessionId ?? ""}, true)`.execute(trx),
    catch: toDatabaseError,
  });

/**
 * Starts a visitor transaction. If binding fails, the transaction rolls back
 * here, so no open transaction is left without an owner.
 */
const openVisitor = (pool: VisitorPool, sessionId: string | undefined) =>
  startTransaction(pool.db).pipe(
    Effect.tap((trx) =>
      bindVisitor(trx, pool.role, sessionId).pipe(
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : settle(trx, exit))),
      ),
    ),
  );

/**
 * Runs `use` on the request's transaction. The first call opens it under the
 * lock, so two concurrent first calls cannot open two transactions and leak
 * one. A later call keeps the session the transaction opened with.
 */
const joinRequest = <A, E, R>(
  slot: RequestSlot,
  pool: VisitorPool,
  sessionId: string | undefined,
  use: (db: KyselyDB) => Step<A, E, R>,
) =>
  Effect.gen(function* () {
    const trx = yield* Semaphore.withPermit(
      slot.lock,
      Effect.flatMap(
        Ref.get(slot.opened),
        Option.match({
          onSome: (trx) => Effect.succeed(trx),
          onNone: () =>
            openVisitor(pool, sessionId).pipe(
              Effect.tap((trx) => Ref.set(slot.opened, Option.some(trx))),
            ),
        }),
      ),
    );
    return yield* toEffect(use(trx));
  });

/**
 * Resolves the visitor pool once and hands back a function that runs a query
 * as the visitor role, in one transaction, with the given session bound for
 * RLS policies to read via `current_setting`.
 *
 * The pool tag stays private to this module: a caller can only ever obtain
 * this closure, never the tag itself, so there is no way to reach the
 * visitor connection without going through the RLS boundary below.
 *
 * A `Context.Service` whose methods all run as the visitor role should
 * resolve this once in its constructor and close over the result, rather
 * than have every method re-`yield*` `PgAuthDB` (see `leakingRequirements`).
 */
export const visitorQuerier = Effect.gen(function* () {
  const pool = yield* PgAuthDB;
  return <A, E, R>(sessionId: string | undefined, use: (db: KyselyDB) => Step<A, E, R>) =>
    // Read the slot per call, not here: this closure is built once per service,
    // and each call must join the request it runs in.
    Effect.serviceOption(RequestTransaction).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            transact(pool.db, (trx) =>
              Effect.andThen(bindVisitor(trx, pool.role, sessionId), toEffect(use(trx))),
            ),
          onSome: (slot) => joinRequest(slot, pool, sessionId, use),
        }),
      ),
    );
});

/**
 * Run a query as the visitor role, in one transaction, with the request's
 * session bound for RLS policies to read via `current_setting`.
 *
 * Inside `withRequestTransaction`, every `asVisitor` shares the request's
 * transaction, so nesting is safe there. The shared transaction keeps the
 * session it opened with. Outside a request, each call takes its own
 * connection: an inner call cannot see the outer transaction's writes and can
 * wait forever on a lock the outer transaction holds. Do not nest there.
 */
export const asVisitor = <A, E = never, R = never>(use: (db: KyselyDB) => Step<A, E, R>) =>
  Effect.gen(function* () {
    const run = yield* visitorQuerier;
    const { session } = yield* CurrentSession;
    return yield* run(session?.id, use);
  });

/**
 * Resolves the root pool once and hands back a function that runs a query as
 * the owning role, in one transaction, bypassing RLS. See `visitorQuerier`
 * for why a `Context.Service` should prefer this over `asRoot`.
 */
export const rootQuerier = Effect.gen(function* () {
  const db = yield* PgRootDB;
  return <A, E, R>(use: (db: KyselyDB) => Step<A, E, R>) =>
    transact(db, (trx) => toEffect(use(trx)));
});

/**
 * Run a query as the owning role, in one transaction, bypassing RLS.
 *
 * The two pools log in as different Postgres roles and hold separate
 * connections, so this transaction is independent of an enclosing `asVisitor`.
 * It is not a savepoint: if the outer boundary rolls back, this one stays
 * committed. It must not nest inside another boundary: the outer transaction can
 * hold a lock this one waits on.
 */
export const asRoot = <A, E = never, R = never>(use: (db: KyselyDB) => Step<A, E, R>) =>
  Effect.flatMap(rootQuerier, (run) => run(use));

/**
 * Runs `effect` as one request. Every `asVisitor` inside it shares one
 * authenticator transaction, opened by the first call that needs it, so a
 * request that never queries as the visitor opens nothing. The transaction
 * commits when `effect` succeeds and rolls back when it fails or is interrupted.
 *
 * Only the authenticator pool is shared. `asRoot` keeps its own transaction,
 * so owner-pool writes such as lockout counters do not roll back with a
 * request that fails later.
 */
export const withRequestTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.all({
      lock: Semaphore.make(1),
      opened: Ref.make(Option.none<ControlledTransaction<DB>>()),
    }),
    (slot) => effect.pipe(Effect.provideService(RequestTransaction, slot)),
    (slot, exit) =>
      Ref.get(slot.opened).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.void, onSome: (trx) => settle(trx, exit) }),
        ),
      ),
  );

/** The authenticator login, and the role each of its transactions switches to. */
interface VisitorPool {
  readonly db: KyselyDB;
  readonly role: string;
}

const openPool = Effect.fnUntraced(function* (urlKey: string) {
  const url = yield* Config.Redacted(urlKey);
  const db = connect(Redacted.value(url));
  yield* Effect.addFinalizer(() => Effect.promise(() => db.destroy()));
  return db;
});

class PgAuthDB extends Context.Service<PgAuthDB, VisitorPool>()("PgAuthDB") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const db = yield* openPool("AUTH_DATABASE_URL");
      const role = yield* Config.String("DATABASE_VISITOR");
      return { db, role };
    }),
  );
}

class PgRootDB extends Context.Service<PgRootDB, KyselyDB>()("PgRootDB") {
  static readonly layer = Layer.effect(this, openPool("DATABASE_URL"));
}

/** The authenticator transaction a request shares. `opened` is empty until the first `asVisitor` opens it. */
interface RequestSlot {
  readonly lock: Semaphore.Semaphore;
  readonly opened: Ref.Ref<Option.Option<ControlledTransaction<DB>>>;
}

class RequestTransaction extends Context.Service<RequestTransaction, RequestSlot>()(
  "RequestTransaction",
) {}

/**
 * What `asVisitor`/`asRoot` need in context. Exported as types only: the tags
 * themselves stay private, so a pool cannot be provided or read from outside.
 */
export type VisitorContext = PgAuthDB | CurrentSession;
export type RootContext = PgRootDB;

export const DatabaseLive = Layer.mergeAll(PgAuthDB.layer, PgRootDB.layer);

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
