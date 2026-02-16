import * as pg from "pg";
import { Effect, Schema } from "effect";
import { PostgresDialect, Transaction, Kysely, sql } from "kysely";
import { env } from "./assertEnv.js";
import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { User, Organization, Playground, Commit };

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ConnectionError extends Schema.TaggedError<ConnectionError>()(
  "ConnectionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const poolOptions = {
  max: 50,
} satisfies pg.PoolConfig;

const makePool = (connectionString: string, label: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        new pg.Pool({
          connectionString,
          ...poolOptions,
        }),
      catch: (error) =>
        new ConnectionError({
          message: `Failed to create ${label} pool`,
          cause: error,
        }),
    }),
    (pool) =>
      Effect.tryPromise({
        try: () => pool.end(),
        catch: (error) =>
          new ConnectionError({
            message: `Failed to close ${label} pool`,
            cause: error,
          }),
      }).pipe(Effect.ignore),
  );

class DbService extends Effect.Service<DbService>()("DbService", {
  scoped: Effect.gen(function* () {
    const rootPool = yield* makePool(env.DATABASE_URL, "root");
    const authPool = yield* makePool(env.AUTH_DATABASE_URL, "auth");

    return {
      rootDb: new Kysely<DB>({
        dialect: new PostgresDialect({ pool: rootPool }),
      }),
      authDb: new Kysely<DB>({
        dialect: new PostgresDialect({ pool: authPool }),
      }),
    };
  }),
}) {}

const DbLayer = DbService.Default;

const toDatabaseError = (error: unknown, fallbackMessage: string) => {
  if (error instanceof DatabaseError) return error;
  if (error instanceof pg.DatabaseError) {
    return new DatabaseError({
      message: error.message,
      code: error.code ?? undefined,
      cause: error,
    });
  }
  return new DatabaseError({
    message: fallbackMessage,
    cause: error,
  });
};

const tryDbPromise = <R>(
  operation: () => Promise<R>,
  fallbackMessage: string,
) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => toDatabaseError(error, fallbackMessage),
  });

export const withRootDb = <R>(
  cb: (db: Kysely<DB>) => Promise<R>,
  fallbackMessage = "Database query failed",
) =>
  Effect.gen(function* () {
    const { rootDb } = yield* DbService;
    return yield* tryDbPromise(() => cb(rootDb), fallbackMessage);
  });

export const withAuthDb = <R>(
  cb: (db: Kysely<DB>) => Promise<R>,
  fallbackMessage = "Database query failed",
) =>
  Effect.gen(function* () {
    const { authDb } = yield* DbService;
    return yield* tryDbPromise(() => cb(authDb), fallbackMessage);
  });

export const withAuthContext = <R>(
  sessionId: string | undefined,
  cb: (sql: Transaction<DB>) => Promise<R>,
  fallbackMessage = "Database transaction failed",
) =>
  Effect.gen(function* () {
    const { authDb } = yield* DbService;
    return yield* tryDbPromise(
      () =>
        authDb.transaction().execute((tx) =>
          sql`
            select
              set_config('role', ${env.DATABASE_VISITOR}, false),
              set_config('my.session_id', ${sessionId ?? null}, true);
          `
            .execute(tx)
            .then(() => cb(tx)),
        ),
      fallbackMessage,
    );
  });

export const runDbEffect = <R, E>(
  effect: Effect.Effect<R, E, DbService>,
) => Effect.runPromise(effect.pipe(Effect.provide(DbLayer)));

export const runRootDb = <R>(
  cb: (db: Kysely<DB>) => Promise<R>,
  fallbackMessage?: string,
) => runDbEffect(withRootDb(cb, fallbackMessage));

export const runAuthDb = <R>(
  cb: (db: Kysely<DB>) => Promise<R>,
  fallbackMessage?: string,
) => runDbEffect(withAuthDb(cb, fallbackMessage));

export const runWithAuthContext = <R>(
  sessionId: string | undefined,
  cb: (sql: Transaction<DB>) => Promise<R>,
  fallbackMessage?: string,
) => runDbEffect(withAuthContext(sessionId, cb, fallbackMessage));

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

export function handleDbError(e: unknown, fallbackMessage: string) {
  if (e instanceof DatabaseError) {
    if (e.code && (CUSTOM_ERROR_CODES as unknown as string[]).includes(e.code)) {
      return { code: 400, error: e.message };
    }
    console.error(e.cause ?? e);
    return { code: 500, error: fallbackMessage };
  }
  if (e instanceof ConnectionError) {
    console.error(e.cause ?? e);
    return { code: 500, error: fallbackMessage };
  }
  if (
    e instanceof pg.DatabaseError &&
    e.code &&
    (CUSTOM_ERROR_CODES as unknown as string[]).includes(e.code)
  ) {
    return { code: 400, error: e.message };
  }
  console.error(e);
  return { code: 500, error: fallbackMessage };
}
