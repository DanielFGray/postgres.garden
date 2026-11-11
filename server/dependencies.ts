import { Duration, Effect, Layer, Schedule, Schema as S } from "effect";
import { Redis } from "effect/persistence/Redis";

/** A service the server cannot work without did not answer. */
export class DependencyUnavailable extends S.TaggedError<
  DependencyUnavailable,
  { readonly brand: unique symbol }
>()("DependencyUnavailable", {
  dependency: S.String,
  cause: S.Defect(),
}) {
  override get message() {
    return `${this.dependency} did not answer`;
  }
}

/**
 * Retries `effect` until `dependency` answers, for about 78 s, and then fails
 * with DependencyUnavailable. Every hard dependency (both Postgres pools in
 * server/db.ts, and Valkey here) waits this way while its layer is built. The
 * server builds them before its listener and its worker (`ServerLive` in
 * server/runtime.ts), so while one is down the port stays closed, the deploy's
 * health check fails, and the platform keeps the old release.
 */
export const waitFor =
  (dependency: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError(() => Effect.logInfo(`Waiting for ${dependency}`)),
      Effect.retry(retrySchedule()),
      Effect.mapError((cause) => new DependencyUnavailable({ dependency, cause })),
    );

/**
 * Builds once Valkey answers a PING (`waitFor`).
 *
 * The retries go to one client. Bun's client opens its connection on first
 * use, and with its offline queue off that first command fails while the
 * connection opens; the PING here is that command, so no request meets it.
 */
export const ValkeyReady = Layer.effectDiscard(
  Redis.use((redis) => redis.send("PING")).pipe(
    waitFor("valkey"),
    Effect.andThen(Effect.log("Valkey is ready")),
    Effect.withSpan("server.waitForValkey"),
  ),
);

/** Exponential backoff from 100 ms, capped at 5 s between attempts, 20 retries. */
function retrySchedule() {
  return Schedule.max([
    Schedule.min([
      Schedule.exponential(Duration.millis(100)),
      Schedule.spaced(Duration.seconds(5)),
    ]),
    Schedule.recurs(20),
  ]);
}
