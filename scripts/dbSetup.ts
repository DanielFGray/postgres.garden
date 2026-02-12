import { Effect, Schedule, pipe, Duration, Schema } from "effect";
import pg from "pg";
import * as Prompt from "../lib/prompt.js";

// Environment variables
const {
  DATABASE_OWNER,
  DATABASE_OWNER_PASSWORD,
  DATABASE_NAME,
  DATABASE_VISITOR,
  DATABASE_AUTHENTICATOR,
  DATABASE_AUTHENTICATOR_PASSWORD,
  ROOT_DATABASE_URL,
} = process.env;

const RECONNECT_BASE_DELAY = 100;
const RECONNECT_MAX_DELAY = 30000;

// Tagged errors using Schema.TaggedError
class DatabaseConnectionError extends Schema.TaggedError<DatabaseConnectionError>()("DatabaseConnectionError", {
  message: Schema.String,
}) { }

class DatabaseAuthError extends Schema.TaggedError<DatabaseAuthError>()("DatabaseAuthError", {
  message: Schema.String,
}) { }

class DatabaseSetupError extends Schema.TaggedError<DatabaseSetupError>()("DatabaseSetupError", {
  error: Schema.Defect,
}) { }

// Create a retry schedule with exponential backoff and max attempts
const retrySchedule = pipe(
  Schedule.exponential(Duration.millis(RECONNECT_BASE_DELAY)),
  Schedule.either(Schedule.spaced(Duration.millis(RECONNECT_MAX_DELAY))),
  Schedule.compose(Schedule.recurs(30)),
);

// Wrap a database query in Effect
const executeQuery = (pool: pg.PoolClient | pg.Pool, query: string) =>
  Effect.tryPromise({
    try: () => pool.query(query),
    catch: (error) => new DatabaseSetupError({ error }),
  });

// Test database connection
const testConnection = (pool: pg.Pool) =>
  Effect.tryPromise({
    try: () => pool.query('select true as "Connection test"'),
    catch: (error: any) => {
      if (error.code === "28P01") {
        return new DatabaseAuthError({ message: error.message });
      }
      return new DatabaseConnectionError({ message: error.message });
    },
  });

// Wait for database to be ready with retry
const waitForDatabase = (pool: pg.Pool) =>
  pipe(
    testConnection(pool),
    Effect.retry({
      schedule: retrySchedule,
      while: (error) => error._tag === "DatabaseConnectionError",
    }),
    Effect.tapError((error) => {
      if (error._tag === "DatabaseConnectionError") {
        return Effect.log(`Database is not ready yet: ${error.message}`);
      }
      return Effect.void;
    }),
    Effect.catchTag("DatabaseAuthError", (error) =>
      Effect.die(new Error(`Database authentication failed: ${error.message}`)),
    ),
    Effect.catchTag("DatabaseConnectionError", () =>
      Effect.gen(function*() {
        yield* Effect.logError("Database never came up, aborting :(");
        yield* Effect.sync(() => process.exit(1));
      }),
    ),
  );

// Acquire a pool connection with resource management
const acquireConnection = (pool: pg.Pool) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => pool.connect(),
      catch: (error) => new DatabaseSetupError({ error }),
    }),
    (client) =>
      Effect.sync(() => {
        client.release();
      }),
  );

// Prompt user for confirmation
const confirmAction = Effect.gen(function*() {
  const result = yield* Prompt.confirm({
    message: "press y to continue:",
    default: true,
  });

  if (!result) {
    yield* Effect.sync(() => process.exit(0));
  }

  return result;
});

// Execute all database setup queries
const executeDatabaseSetup = (rootPgPool: pg.PoolClient) =>
  Effect.gen(function*() {
    // Drop existing databases and roles
    yield* executeQuery(rootPgPool, `drop database if exists ${DATABASE_NAME}`);
    yield* executeQuery(
      rootPgPool,
      `drop database if exists ${DATABASE_NAME}_shadow`,
    );
    yield* executeQuery(
      rootPgPool,
      `drop database if exists ${DATABASE_NAME}_test`,
    );
    yield* executeQuery(rootPgPool, `drop role if exists ${DATABASE_VISITOR}`);
    yield* executeQuery(
      rootPgPool,
      `drop role if exists ${DATABASE_AUTHENTICATOR}`,
    );
    yield* executeQuery(rootPgPool, `drop role if exists ${DATABASE_OWNER}`);

    // Create databases
    yield* executeQuery(rootPgPool, `create database ${DATABASE_NAME}`);
    yield* Effect.log(`CREATE DATABASE ${DATABASE_NAME}`);

    yield* executeQuery(rootPgPool, `create database ${DATABASE_NAME}_shadow`);
    yield* Effect.log(`CREATE DATABASE ${DATABASE_NAME}_shadow`);

    yield* executeQuery(rootPgPool, `create database ${DATABASE_NAME}_test`);
    yield* Effect.log(`CREATE DATABASE ${DATABASE_NAME}_test`);

    // Create owner role
    if (process.env.NODE_ENV === "production") {
      yield* executeQuery(
        rootPgPool,
        `create role ${DATABASE_OWNER} with login password '${DATABASE_OWNER_PASSWORD}' noinherit`,
      );
      yield* Effect.log(`CREATE ROLE ${DATABASE_OWNER}`);
    } else {
      yield* executeQuery(
        rootPgPool,
        `create role ${DATABASE_OWNER} with login password '${DATABASE_OWNER_PASSWORD}' superuser`,
      );
      yield* Effect.log(`CREATE ROLE ${DATABASE_OWNER} SUPERUSER`);
    }

    // Grant privileges
    yield* executeQuery(
      rootPgPool,
      `grant all privileges on database ${DATABASE_NAME} to ${DATABASE_OWNER}`,
    );
    yield* Effect.log(`GRANT ${DATABASE_OWNER}`);

    // Create authenticator role
    yield* executeQuery(
      rootPgPool,
      `create role ${DATABASE_AUTHENTICATOR} with login password '${DATABASE_AUTHENTICATOR_PASSWORD}' noinherit`,
    );
    yield* Effect.log(`CREATE ROLE ${DATABASE_AUTHENTICATOR}`);

    // Create visitor role
    yield* executeQuery(rootPgPool, `create role ${DATABASE_VISITOR}`);
    yield* Effect.log(`CREATE ROLE ${DATABASE_VISITOR}`);

    // Grant visitor to authenticator
    yield* executeQuery(
      rootPgPool,
      `grant ${DATABASE_VISITOR} to ${DATABASE_AUTHENTICATOR}`,
    );
    yield* Effect.log(`GRANT ${DATABASE_VISITOR} TO ${DATABASE_AUTHENTICATOR}`);
  });

// Main program
const program = Effect.gen(function*() {
  const pgPool = new pg.Pool({ connectionString: ROOT_DATABASE_URL });

  // Use ensuring to guarantee pool cleanup
  yield* pipe(
    Effect.gen(function*() {
      // Wait for database to be ready
      yield* waitForDatabase(pgPool);

      // Display planned actions
      yield* Effect.log(`DROP DATABASE ${DATABASE_NAME}`);
      yield* Effect.log(`DROP ROLE ${DATABASE_VISITOR}`);
      yield* Effect.log(`DROP ROLE ${DATABASE_AUTHENTICATOR}`);
      yield* Effect.log(`DROP ROLE ${DATABASE_OWNER}`);

      // Get user confirmation
      yield* confirmAction;

      // Execute setup with resource management
      yield* Effect.scoped(
        pipe(
          acquireConnection(pgPool),
          Effect.andThen((rootPgPool) => executeDatabaseSetup(rootPgPool)),
          Effect.catchAll((error) =>
            Effect.gen(function*() {
              yield* Effect.logError(`Database setup error: ${error}`);
            }),
          ),
        ),
      );
    }),
    Effect.ensuring(
      Effect.sync(() => {
        pgPool.end();
      }),
    ),
  );
});

// Run the program - Effect runtime handles SIGINT/SIGTERM automatically
Effect.runFork(program);
