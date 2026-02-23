import { Effect, Schedule, pipe, Duration, Schema } from "effect";
import { sql } from "kysely";
import { PgRootDB, PgAuthDB, type KyselyDB } from "./db.js";
import { valkey } from "./valkey.js";

class PostgresNotReady extends Schema.TaggedError<PostgresNotReady>()("PostgresNotReady", {
  message: Schema.String,
}) {}

class ValkeyNotReady extends Schema.TaggedError<ValkeyNotReady>()("ValkeyNotReady", {
  message: Schema.String,
}) {}

const retrySchedule = pipe(
  Schedule.exponential(Duration.millis(100)),
  Schedule.either(Schedule.spaced(Duration.millis(5000))),
  Schedule.compose(Schedule.recurs(20)),
);

const testDb = (db: KyselyDB, name: string) =>
  pipe(
    db.selectNoFrom([sql.lit(1).as("ready")]),
    Effect.asVoid,
    Effect.mapError(
      (e) =>
        new PostgresNotReady({
          message: `${name}: ${e instanceof Error ? e.message : String(e)}`,
        }),
    ),
    Effect.retry(retrySchedule),
    Effect.catchTag("PostgresNotReady", (e) =>
      Effect.die(new Error(`Postgres not ready after retries: ${e.message}`)),
    ),
  );

const waitForPostgres = Effect.gen(function* () {
  const rootDb = yield* PgRootDB;
  const authDb = yield* PgAuthDB;
  yield* Effect.all([testDb(rootDb, "rootDb"), testDb(authDb, "authDb")], {
    concurrency: "unbounded",
  });
  yield* Effect.log("Postgres is ready");
});

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

export const waitForDependencies = Effect.all([waitForPostgres, waitForValkey], {
  concurrency: "unbounded",
}).pipe(Effect.withSpan("server.waitForDependencies"));
