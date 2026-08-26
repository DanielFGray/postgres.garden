import { Context, Effect, Layer, Config, Match, Schedule, Duration, Schema } from "effect";
import * as pg from "pg";

// Configure pg to return bigint for int8 columns (OID 20) instead of string
pg.types.setTypeParser(20, BigInt);
import * as SqlClient from "@effect/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import * as PgKysely from "@effect/sql-kysely/Pg";
import { trace, SpanStatusCode } from "@opentelemetry/api";

import { CurrentSession } from "./apiSchema.js";
import { env } from "./assertEnv.js";
import { logError } from "./otel-logger.js";
import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { DB, User, Organization, Playground, Commit };

export type KyselyDB = PgKysely.EffectKysely<DB>;

export const pgConfig: PgClient.PgClientConfig = {} as const;

const withDatabaseRetry = <E, A, R>(layer: Layer.Layer<E, A, R>) =>
  Layer.retry(
    layer,
    Schedule.identity<Layer.Layer.Error<typeof layer>>().pipe(
      Schedule.check(
        (input) =>
          input && typeof input === "object" && "_tag" in input && input._tag === "SqlError",
      ),
      Schedule.intersect(Schedule.exponential("100 millis")),
      Schedule.intersect(Schedule.forever),
      Schedule.jittered,
      Schedule.onDecision(([[_error, duration], attempt], decision) =>
        decision._tag === "Continue"
          ? Effect.logInfo(
              `Retrying database connection in ${Duration.format(duration)} (attempt #${++attempt})`,
            )
          : Effect.void,
      ),
    ),
  );

/**
 * Resolves the visitor pool once and hands back a function that runs a query
 * as the visitor role, in one transaction, with the given session bound for
 * RLS policies to read via `current_setting`.
 *
 * The pool tag stays private to this module: a caller can only ever obtain
 * this closure, never the tag itself, so there is no way to reach the
 * visitor connection without going through the RLS boundary below.
 *
 * A `Effect.Service` whose methods all run as the visitor role should
 * resolve this once in its constructor and close over the result, rather
 * than have every method re-`yield*` `AuthPool` (see `leakingRequirements`).
 */
export const visitorQuerier = Effect.gen(function* () {
  const { sql, db } = yield* AuthPool;
  return <A, E, R>(sessionId: string | undefined, use: (db: KyselyDB) => Effect.Effect<A, E, R>) =>
    sql.withTransaction(
      Effect.zipRight(
        // Both settings are transaction-local. A session-local role would
        // outlive the request on a pooled connection and leak one visitor's
        // identity into the next request that reuses it.
        sql`select set_config('role', ${env.DATABASE_VISITOR}, true),
                   set_config('my.session_id', ${sessionId ?? ""}, true)`,
        use(db),
      ),
    );
});

/**
 * Run a query as the visitor role, in one transaction, with the request's
 * session bound for RLS policies to read via `current_setting`.
 *
 * Nested boundaries become savepoints, so wrapping an effect that already
 * established one is safe.
 */
export const asVisitor = <A, E, R>(use: (db: KyselyDB) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const run = yield* visitorQuerier;
    const { session } = yield* CurrentSession;
    return yield* run(session?.id, use);
  });

/**
 * Resolves the root pool once and hands back a function that runs a query as
 * the owning role, in one transaction, bypassing RLS. See `visitorQuerier`
 * for why a `Effect.Service` should prefer this over `asRoot`.
 */
export const rootQuerier = Effect.gen(function* () {
  const { sql, db } = yield* RootPool;
  return <A, E, R>(use: (db: KyselyDB) => Effect.Effect<A, E, R>) => sql.withTransaction(use(db));
});

/**
 * Run a query as the owning role, in one transaction, bypassing RLS.
 *
 * The two pools log in as different Postgres roles, so an `asRoot` nested
 * inside an `asVisitor` is an independent transaction on another connection,
 * not a savepoint: if the outer boundary rolls back, this one stays committed.
 */
export const asRoot = <A, E, R>(use: (db: KyselyDB) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(rootQuerier, (run) => run(use));

/**
 * A connection pool plus the Kysely instance bound to it. The pool is chosen
 * by which of `asVisitor`/`asRoot` you enter.
 */
interface Pool {
  readonly sql: SqlClient.SqlClient;
  readonly db: KyselyDB;
}

class AuthPool extends Context.Tag("AuthPool")<AuthPool, Pool>() {}
class RootPool extends Context.Tag("RootPool")<RootPool, Pool>() {}

/**
 * What `asVisitor`/`asRoot` need in context. Exported as types only: the tags
 * themselves stay private, so a pool cannot be provided or read from outside.
 */
export type VisitorContext = AuthPool | CurrentSession;
export type RootContext = RootPool;

const poolLayer = <I>(tag: Context.Tag<I, Pool>, urlKey: string) =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const db = yield* PgKysely.make<DB>();
      return { sql, db };
    }),
  ).pipe(
    Layer.provide(
      Layer.unwrapEffect(
        Config.redacted(urlKey).pipe(Effect.andThen((url) => PgClient.layer({ url, ...pgConfig }))),
      ).pipe(withDatabaseRetry),
    ),
  );

export const AuthPoolLive = poolLayer(AuthPool, "AUTH_DATABASE_URL");
export const RootPoolLive = poolLayer(RootPool, "DATABASE_URL");
export const DatabaseLive = Layer.mergeAll(AuthPoolLive, RootPoolLive);

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

/** Unwrap @effect/sql SqlError to get the underlying database error. */
const ErrorCarrier = Schema.Struct({ cause: Schema.optional(Schema.Unknown) });
const unwrapCause = (cause: unknown) => {
  const decoded = Schema.decodeUnknownEither(ErrorCarrier)(cause);
  return Match.value(decoded).pipe(
    Match.tags({ Left: () => cause, Right: ({ right }) => right.cause ?? cause }),
    Match.exhaustive,
  );
};

export function handleDbError(cause: unknown, fallbackMessage: string) {
  Schema.decodeUnknownEither(ErrorCarrier)(cause);
  const span = trace.getActiveSpan();
  const dbCause = unwrapCause(cause);
  if (
    dbCause instanceof pg.DatabaseError &&
    dbCause.code &&
    CUSTOM_ERROR_CODES.includes(dbCause.code)
  ) {
    span?.setAttribute("db.error_code", dbCause.code);
    return { code: 400, error: dbCause.message };
  }
  if (span) {
    span.recordException(cause instanceof Error ? cause : new Error(String(cause)));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  logError("Database error", cause);
  return { code: 500, error: fallbackMessage };
}
