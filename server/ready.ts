import { Effect, Schedule, pipe, Duration, Schema } from "effect";
import * as pg from "pg";
import { env } from "./assertEnv.js";
import { valkey } from "./valkey.js";

class PostgresNotReady extends Schema.TaggedError<PostgresNotReady>()(
  "PostgresNotReady",
  { message: Schema.String },
) {}

class ValkeyNotReady extends Schema.TaggedError<ValkeyNotReady>()(
  "ValkeyNotReady",
  { message: Schema.String },
) {}

const retrySchedule = pipe(
  Schedule.exponential(Duration.millis(100)),
  Schedule.either(Schedule.spaced(Duration.millis(5000))),
  Schedule.compose(Schedule.recurs(20)),
);

function testPool(connectionString: string, name: string) {
  const makePool = Effect.acquireRelease(
    Effect.sync(
      () =>
        new pg.Pool({
          connectionString,
          max: 2,
        }),
    ),
    (pool) =>
      Effect.tryPromise({
        try: () => pool.end(),
        catch: () => undefined,
      }).pipe(Effect.ignore),
  );

  const queryReady = Effect.gen(function* () {
    const pool = yield* makePool;
    return yield* Effect.tryPromise({
      try: async () => {
        const client = await pool.connect();
        try {
          await client.query("SELECT 1 AS ready");
        } finally {
          client.release();
        }
      },
      catch: (e) => {
        const err = e as { message?: string };
        return new PostgresNotReady({
          message: `${name}: ${err.message ?? String(e)}`,
        });
      },
    });
  });

  return pipe(
    Effect.scoped(queryReady),
    Effect.retry(retrySchedule),
    Effect.catchTag("PostgresNotReady", (e) =>
      Effect.die(new Error(`Postgres not ready after retries: ${e.message}`)),
    ),
  );
}

const waitForPostgres = pipe(
  Effect.all(
    [
      testPool(env.DATABASE_URL, "rootPg"),
      testPool(env.AUTH_DATABASE_URL, "authPg"),
    ],
    {
    concurrency: "unbounded",
    },
  ),
  Effect.tap(() => Effect.log("Postgres is ready")),
);

const waitForValkey = pipe(
  Effect.tryPromise({
    try: () => valkey.ping(),
    catch: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      return new ValkeyNotReady({ message: msg });
    },
  }),
  Effect.retry(retrySchedule),
  Effect.tap(() => Effect.log("Valkey is ready")),
  Effect.catchTag("ValkeyNotReady", (e) =>
    Effect.die(new Error(`Valkey not ready after retries: ${e.message}`)),
  ),
);

export const waitForDependencies = Effect.all(
  [waitForPostgres, waitForValkey],
  { concurrency: "unbounded" },
);
