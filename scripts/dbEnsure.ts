import pg from "pg";
import runAll from "npm-run-all";
import "dotenv/config";
import { Effect, Schedule, pipe, Duration, Schema } from "effect";

// Define custom error types for better error handling using Schema.TaggedError
class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  attempts: Schema.optional(Schema.Number),
}) {}

class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String,
}) {}

interface DbTestOptions {
  minDelay?: number;
  maxTries?: number;
  maxDelay?: number;
  verbose?: boolean;
}

/**
 * Test database connection with Effect-based retry logic
 */
export function dbTest(
  url: string,
  options: DbTestOptions = {},
): Effect.Effect<boolean, DatabaseError | ConfigurationError> {
  const { minDelay = 50, maxTries = Infinity, maxDelay = 30000, verbose = true } = options;

  // Acquire and release the pool using Effect.acquireRelease
  const makePool = Effect.acquireRelease(
    Effect.sync(
      () =>
        new pg.Pool({
          connectionString: url,
          connectionTimeoutMillis: 3000,
        }),
    ),
    (pool) => Effect.promise(() => pool.end()),
  );

  // Scoped effect that performs the database test
  const performTest = Effect.gen(function* () {
    const pool = yield* makePool;

    // Single test query wrapped in Effect.tryPromise
    const queryEffect = Effect.tryPromise({
      try: () => pool.query<{ test: boolean }>('select true as "test"'),
      catch: (error) => {
        const pgError = error as { code?: string; message?: string };
        return new DatabaseError({
          message: pgError.message || "Unknown database error",
          code: pgError.code,
        });
      },
    });

    // Execute query and validate result
    const result = yield* queryEffect;

    if (result.rows[0]?.test === true) {
      return true;
    }

    return yield* Effect.fail(
      new DatabaseError({
        message: "Database test query returned unexpected result",
      }),
    );
  });

  // Define retry policy with exponential backoff
  // Formula from original: Math.floor((minDelay * 1.8 ** attempts) / 2)
  const baseSchedule = Schedule.exponential(Duration.millis(minDelay), 1.8);

  // Apply transformations to match original formula
  const delaySchedule = pipe(
    baseSchedule,
    Schedule.union(Schedule.spaced(Duration.millis(maxDelay))),
  );

  const retrySchedule =
    maxTries !== Infinity
      ? pipe(delaySchedule, Schedule.intersect(Schedule.recurs(maxTries)))
      : delaySchedule;

  // Retry with custom error handling
  const withRetry = pipe(
    performTest,
    Effect.retry({
      schedule: retrySchedule,
      while: (error) => {
        // Don't retry on authentication failures (code 28P01)
        if (error._tag === "DatabaseError" && error.code === "28P01") {
          return false;
        }
        return true;
      },
    }),
    Effect.tapError((error) => {
      if (verbose && error._tag === "DatabaseError") {
        return Effect.logWarning(`Database is not ready yet: ${error.message}`);
      }
      return Effect.void;
    }),
  );

  // Run the scoped effect
  return Effect.scoped(withRetry);
}

// Main script execution
const runAllOpts = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  silent: true,
};

const mainProgram = Effect.gen(function* () {
  // Check for DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return yield* Effect.fail(
      new ConfigurationError({
        message: "DATABASE_URL is not set",
      }),
    );
  }

  // Start database using npm-run-all
  yield* Effect.tryPromise({
    try: () => runAll(["db:up"], runAllOpts),
    catch: (error) =>
      new DatabaseError({
        message: `Failed to start database: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  // Test database connection with retries
  const result = yield* dbTest(databaseUrl, {
    maxTries: 7,
    verbose: false,
  });

  yield* Effect.log("Database is ready");
  return result;
});

// Error handling for the main program
const programWithErrorHandling = pipe(
  mainProgram,
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      const errorMessage =
        error._tag === "DatabaseError" || error._tag === "ConfigurationError"
          ? error.message
          : String(error);

      yield* Effect.logError(errorMessage);

      // Try to run init on failure
      yield* Effect.tryPromise({
        try: () => runAll(["init"], runAllOpts),
        catch: (initError) =>
          new DatabaseError({
            message: `Init failed: ${initError instanceof Error ? initError.message : String(initError)}`,
          }),
      }).pipe(
        Effect.tapError((initError) => Effect.logError(initError.message)),
        Effect.ignore, // Don't fail if init fails
      );

      return false;
    }),
  ),
);

// Run the program
Effect.runPromise(programWithErrorHandling).catch(console.error);
