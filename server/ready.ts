import { Context, Duration, Effect, Layer, Schedule, Schema as S } from "effect";
import { Redis } from "effect/persistence/Redis";
import { sql } from "kysely";
import { PgAuthDB, PgRootDB } from "./db.js";

/** A service the server cannot work without did not answer. */
export class DependencyUnavailable extends S.TaggedError<
  DependencyUnavailable,
  { readonly brand: unique symbol }
>()("DependencyUnavailable", {
  dependency: S.String,
  message: S.String,
}) {}

/**
 * Probes the services the server cannot work without: both Postgres pools and
 * Valkey. Both pools, because they log in as different roles. The visitor probe
 * runs as an anonymous visitor, so it exercises the role switch as well as the
 * socket.
 */
export class Readiness extends Context.Service<Readiness>()("Readiness", {
  make: Effect.gen(function* () {
    const root = yield* PgRootDB;
    const auth = yield* PgAuthDB;
    const redis = yield* Redis;
    const probes = [
      probe("postgres (owner pool)", root.all(root.raw(ping))),
      probe("postgres (visitor pool)", auth.all(auth.raw(ping))),
      probe("valkey", redis.send("PING")),
    ];

    return {
      /**
       * Blocks until every dependency answers, retrying with backoff for about
       * a minute. Run it before the server accepts connections: a container
       * that starts beside its database would otherwise answer 500 to every
       * request that arrives while Postgres is still coming up.
       */
      waitUntilReady: Effect.forEach(probes, ({ waited }) => waited, {
        concurrency: "unbounded",
      }).pipe(
        Effect.asVoid,
        Effect.tap(() => Effect.log("Dependencies are ready")),
        Effect.withSpan("server.waitForDependencies"),
      ),
      /**
       * One bounded attempt at each dependency, for the health endpoint. It
       * does not retry: a health check answers what is true now and lets the
       * platform decide, where retrying would hold the request open past the
       * platform's own timeout and report healthy on the way out.
       */
      check: Effect.forEach(probes, ({ checked }) => checked, { concurrency: "unbounded" }).pipe(
        Effect.asVoid,
        Effect.withSpan("server.checkDependencies"),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

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
const probe = <A, E>(dependency: string, check: Effect.Effect<A, E>) => {
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

const ping = sql`select 1`;
