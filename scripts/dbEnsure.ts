import pg from "pg";
import runAll from "npm-run-all";
import "dotenv/config";
import { NodeRuntime } from "@effect/platform-node";
import { Config, Duration, Effect, Schedule, Schema, pipe } from "effect";

class DatabaseError extends Schema.TaggedError<DatabaseError, { readonly brand: unique symbol }>()(
  "DatabaseError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {}

class ConfigurationError extends Schema.TaggedError<
  ConfigurationError,
  { readonly brand: unique symbol }
>()("ConfigurationError", {
  message: Schema.String,
}) {}

/** Postgres rejected the password. Retrying cannot fix that. */
const AUTH_FAILED = "28P01";

/**
 * Connects and runs a trivial query, retrying with exponential backoff
 * (`minDelay` * 1.8^n, capped at `maxDelay`) for at most `maxTries` retries.
 */
const dbTest = (
  url: string,
  { minDelay = 50, maxTries = Infinity, maxDelay = 30000, verbose = true } = {},
) => {
  const makePool = Effect.acquireRelease(
    Effect.sync(() => new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 })),
    (pool) => Effect.promise(() => pool.end()),
  );

  const performTest = Effect.gen(function* () {
    const pool = yield* makePool;
    const result = yield* Effect.tryPromise({
      try: () => pool.query<{ test: boolean }>('select true as "test"'),
      catch: (error) =>
        new DatabaseError({
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof pg.DatabaseError ? error.code : undefined,
        }),
    });

    if (result.rows[0]?.test === true) {
      return true;
    }
    return yield* new DatabaseError({ message: "Database test query returned unexpected result" });
  });

  const backoff = Schedule.min([
    Schedule.exponential(Duration.millis(minDelay), 1.8),
    Schedule.spaced(Duration.millis(maxDelay)),
  ]);
  const retrySchedule =
    maxTries === Infinity ? backoff : Schedule.max([backoff, Schedule.recurs(maxTries)]);

  return pipe(
    performTest,
    Effect.retry({ schedule: retrySchedule, while: (error) => error.code !== AUTH_FAILED }),
    Effect.tapError((error) =>
      verbose ? Effect.logWarning(`Database is not ready yet: ${error.message}`) : Effect.void,
    ),
    Effect.scoped,
  );
};

const runAllOpts = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  silent: true,
};

const run = (script: string) =>
  Effect.tryPromise({
    try: () => runAll([script], runAllOpts),
    catch: (error) =>
      new DatabaseError({
        message: `Failed to start database: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const mainProgram = Effect.gen(function* () {
  const url = yield* Config.String("DATABASE_URL").pipe(
    Effect.mapError(() => new ConfigurationError({ message: "DATABASE_URL is not set" })),
  );

  // `ops dev db up` needs a login to the database host, so ask ops only when
  // the database does not answer. Valkey is local; starting it again is a no-op.
  const result = yield* dbTest(url, { maxTries: 0, verbose: false }).pipe(
    Effect.catch(() =>
      run("db:up").pipe(Effect.andThen(dbTest(url, { maxTries: 7, verbose: false }))),
    ),
  );
  yield* run("valkey:up");

  yield* Effect.log("Database is ready");
  return result;
});

const programWithErrorHandling = mainProgram.pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Effect.logError(error.message);

      // A database that never came up is probably a fresh checkout, so try `init`.
      // A failed init is logged and not fatal: dev can still start without a database.
      yield* Effect.tryPromise({
        try: () => runAll(["init"], runAllOpts),
        catch: (initError) =>
          new DatabaseError({
            message: `Init failed: ${initError instanceof Error ? initError.message : String(initError)}`,
          }),
      }).pipe(
        Effect.tapError((initError) => Effect.logError(initError.message)),
        Effect.ignore,
      );

      return false;
    }),
  ),
);

NodeRuntime.runMain(programWithErrorHandling);
