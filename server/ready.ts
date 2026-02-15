import { Effect, Schedule, pipe, Duration, Schema } from "effect";
import type * as pg from "pg";
import { rootPg, authPg } from "./db.js";
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

function testPool(pool: pg.Pool, name: string) {
  return pipe(
    Effect.tryPromise({
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
    }),
    Effect.retry(retrySchedule),
    Effect.catchTag("PostgresNotReady", (e) =>
      Effect.die(new Error(`Postgres not ready after retries: ${e.message}`)),
    ),
  );
}

const waitForPostgres = pipe(
  Effect.all([testPool(rootPg, "rootPg"), testPool(authPg, "authPg")], {
    concurrency: "unbounded",
  }),
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
