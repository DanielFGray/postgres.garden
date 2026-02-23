import { Context, Effect, Layer, Config, Schedule, Duration } from "effect";
import * as pg from "pg";
import { sql } from "kysely";

// Configure pg to return bigint for int8 columns (OID 20) instead of string
pg.types.setTypeParser(20, BigInt);
import type { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import * as PgKysely from "@effect/sql-kysely/Pg";
import { trace, SpanStatusCode } from "@opentelemetry/api";

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

export class PgAuthDB extends Context.Tag("PgAuthDB")<PgAuthDB, KyselyDB>() {
  static Conn = Layer.unwrapEffect(
    Config.redacted("AUTH_DATABASE_URL").pipe(
      Effect.andThen((url) => PgClient.layer({ url, ...pgConfig })),
    ),
  ).pipe(withDatabaseRetry);
  static Kysely = Layer.effect(this, PgKysely.make<DB>());
  static Live = this.Kysely.pipe(Layer.provide(this.Conn));
}

export class PgRootDB extends Context.Tag("PgRootDB")<PgRootDB, KyselyDB>() {
  static Conn = Layer.unwrapEffect(
    Config.redacted("DATABASE_URL").pipe(
      Effect.andThen((url) => PgClient.layer({ url, ...pgConfig })),
    ),
  ).pipe(withDatabaseRetry);
  static Kysely = Layer.effect(this, PgKysely.make<DB>());
  static Live = this.Kysely.pipe(Layer.provide(this.Conn));
}

/** Run an Effect inside a transaction with Postgres RLS context (role + session). */
export const withAuthContext = <A, E>(
  db: KyselyDB,
  sessionId: string | undefined,
  effect: Effect.Effect<A, E | SqlError, never>,
) =>
  db.withTransaction(
    Effect.gen(function*() {
      yield* db.selectNoFrom([
        sql<string>`set_config('role', ${env.DATABASE_VISITOR}, false)`.as("_role"),
        sql<string>`set_config('my.session_id', ${sessionId ?? ""}, true)`.as("_session"),
      ]);
      return yield* effect;
    }),
  );

const CUSTOM_ERROR_CODES = [
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
] as const;

/** Unwrap @effect/sql SqlError to get the underlying database error. */
const unwrapCause = (e: unknown): unknown =>
  e && typeof e === "object" && "cause" in e ? ((e as { cause: unknown }).cause ?? e) : e;

export function handleDbError(e: unknown, fallbackMessage: string) {
  const span = trace.getActiveSpan();
  const cause = unwrapCause(e);
  if (
    cause instanceof pg.DatabaseError &&
    cause.code &&
    (CUSTOM_ERROR_CODES as unknown as string[]).includes(cause.code)
  ) {
    span?.setAttribute("db.error_code", cause.code);
    return { code: 400, error: cause.message };
  }
  if (span) {
    span.recordException(e instanceof Error ? e : new Error(String(e)));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  logError("Database error", e);
  return { code: 500, error: fallbackMessage };
}
