import { Duration, Effect, Schedule, Schema as S } from "effect";
import { sql } from "kysely";
import { CurrentSession } from "./apiSchema.js";
import { asRoot, asVisitor, runQuery, type KyselyDB } from "./db.js";
import { Redis } from "effect/persistence/Redis";
import { workerFailed } from "./worker.js";

/** A service the server cannot work without did not answer. */
export class DependencyUnavailable extends S.TaggedError<
  DependencyUnavailable,
  { readonly brand: unique symbol }
>()("DependencyUnavailable", {
  dependency: S.String,
  message: S.String,
}) {}

/**
 * Blocks until every dependency answers, retrying with backoff for about a
 * minute. Run it before the server accepts connections: a container that
 * starts beside its database would otherwise answer 500 to every request that
 * arrives while Postgres is still coming up.
 *
 * Wrapped in `suspend` so the probes below can be declared after the two
 * entries a reader of this module is looking for.
 */
export const waitForDependencies = Effect.suspend(() =>
  Effect.all([ownerPool.waited, visitorPool.waited, cache.waited], {
    concurrency: "unbounded",
  }),
).pipe(
  Effect.asVoid,
  Effect.tap(() => Effect.log("Dependencies are ready")),
  Effect.provideService(CurrentSession, { user: null, session: null }),
  Effect.withSpan("server.waitForDependencies"),
);

/**
 * One bounded attempt at each dependency, for the health endpoint. It does not
 * retry: a health check answers what is true now and lets the platform decide,
 * where retrying would hold the request open past the platform's own timeout
 * and report healthy on the way out.
 */
export const checkDependencies = Effect.suspend(() =>
  Effect.all([ownerPool.checked, visitorPool.checked, cache.checked, worker], {
    concurrency: "unbounded",
  }),
).pipe(
  Effect.asVoid,
  Effect.provideService(CurrentSession, { user: null, session: null }),
  Effect.withSpan("server.checkDependencies"),
);

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

/** Exponential backoff from 100ms, capped at 5s between attempts, 20 retries. */
const retrySchedule = Schedule.max([
  Schedule.min([
    Schedule.exponential(Duration.millis(100)),
    Schedule.spaced(Duration.millis(5000)),
  ]),
  Schedule.recurs(20),
]);

const probeTimeout = Duration.seconds(2);

/** Names one dependency's probe and gives it the two shapes callers need. */
const probe = <A, E, R>(dependency: string, check: Effect.Effect<A, E, R>) => {
  const attempt = check.pipe(
    Effect.asVoid,
    Effect.catch((cause) => new DependencyUnavailable({ dependency, message: String(cause) })),
  );
  return {
    waited: attempt.pipe(Effect.retry(retrySchedule)),
    checked: attempt.pipe(
      Effect.timeoutOrElse({
        duration: probeTimeout,
        orElse: () =>
          Effect.fail(
            new DependencyUnavailable({
              dependency,
              message: `no answer within ${Duration.format(probeTimeout)}`,
            }),
          ),
      }),
    ),
  };
};

const ping = (db: KyselyDB) => runQuery(db.selectNoFrom([sql.lit(1).as("ready")]));

// Not in waitForDependencies: a worker that fails should not hold the server
// back from serving. Health reports it instead.
const worker = Effect.suspend(() =>
  workerFailed()
    ? Effect.fail(
        new DependencyUnavailable({ dependency: "worker", message: "the worker has stopped" }),
      )
    : Effect.void,
);

// Both pools, because they log in as different roles. The visitor probe runs as
// an anonymous visitor, so it exercises the role switch as well as the socket.
const ownerPool = probe("postgres (owner pool)", asRoot(ping));
const visitorPool = probe("postgres (visitor pool)", asVisitor(ping));
const cache = probe(
  "valkey",
  Redis.use((redis) => redis.send("PING")),
);
