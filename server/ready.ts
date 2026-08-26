import { Effect, Schedule, pipe, Duration, Schema as S } from "effect";
import { sql } from "kysely";
import { asRoot, asVisitor, type KyselyDB } from "./db.js";
import { CurrentSession } from "./apiSchema.js";
import { valkey } from "./valkey.js";

class PostgresNotReady extends S.TaggedError<PostgresNotReady>()("PostgresNotReady", {
  message: S.String,
}) {}

class ValkeyNotReady extends S.TaggedError<ValkeyNotReady>()("ValkeyNotReady", {
  message: S.String,
}) {}

const retrySchedule = pipe(
  Schedule.exponential(Duration.millis(100)),
  Schedule.either(Schedule.spaced(Duration.millis(5000))),
  Schedule.compose(Schedule.recurs(20)),
);

const testDb = <A, E, R>(probe: Effect.Effect<A, E, R>, name: string) =>
  pipe(
    probe,
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

const ping = (db: KyselyDB) => db.selectNoFrom([sql.lit(1).as("ready")]);

/**
 * Probes both pools. The visitor probe runs as an anonymous visitor, which
 * exercises the role switch as well as connectivity.
 */
const waitForPostgres = Effect.gen(function* () {
  yield* Effect.all([testDb(asRoot(ping), "rootDb"), testDb(asVisitor(ping), "authDb")], {
    concurrency: "unbounded",
  });
  yield* Effect.log("Postgres is ready");
}).pipe(Effect.provideService(CurrentSession, { user: null, session: null }));

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
