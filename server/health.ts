import { Config, Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { Redis } from "effect/persistence/Redis";
import { sql } from "kysely";

import { Worker } from "../worker/worker.js";
import { PgAuthDB, PgRootDB } from "./db.js";

/**
 * The platform health contract (server-ansible docs/design/health-checks.md):
 * `GET /healthz` answers 200 `{status, commit}` when the app can serve, and 503
 * `{status, commit, failed}` naming each dependency that cannot answer:
 * `database` (either Postgres pool), `valkey` or `worker`. The route is public,
 * so error detail goes to the log, not the body. `commit` is `GIT_COMMIT`,
 * which the platform sets in every release.
 *
 * No probe is traced. The route is not in the API contract, so `PagesUntraced`
 * skips its server span; `withTracerEnabled` below covers the spans inside the
 * handler, such as its db.query spans.
 */
export const HealthLive = Layer.unwrap(
  Effect.gen(function* () {
    const commit = yield* Config.String("GIT_COMMIT").pipe(Config.withDefault("unknown"));
    const worker = yield* Worker;
    const root = yield* PgRootDB;
    const auth = yield* PgAuthDB;
    const redis = yield* Redis;
    // Both pools, because they log in as different roles.
    const databases = Effect.all([root.all(root.raw(ping)), auth.all(auth.raw(ping))], {
      concurrency: "unbounded",
    });
    return HttpRouter.add(
      "GET",
      "/healthz",
      Effect.gen(function* () {
        const [databaseUp, valkeyUp, workerUp] = yield* Effect.all(
          [answers("database", databases), answers("valkey", redis.send("PING")), worker.isRunning],
          { concurrency: "unbounded" },
        );
        const failed = [
          ...(databaseUp ? [] : ["database"]),
          ...(valkeyUp ? [] : ["valkey"]),
          ...(workerUp ? [] : ["worker"]),
        ];
        // The platform probes every few seconds. A line for each passing probe
        // would push the boot and job lines out of `ops logs`, so only a
        // failing probe is logged.
        return yield* failed.length === 0
          ? HttpServerResponse.json({ status: "ok", commit }, noStore).pipe(
              HttpMiddleware.withLoggerDisabled,
            )
          : HttpServerResponse.json(
              { status: "error", commit, failed },
              { ...noStore, status: 503 },
            );
      }).pipe(Effect.withTracerEnabled(false)),
    );
  }),
);

/**
 * Whether `dependency` answers `check` now. It does not retry: a health check
 * answers what is true now and lets the platform decide. The platform polls
 * every few seconds, so a dependency that cannot answer in 2 s counts as down,
 * and its cause goes to the log.
 */
const answers = <A, E>(dependency: string, check: Effect.Effect<A, E>) =>
  check.pipe(
    Effect.timeout("2 seconds"),
    Effect.as(true),
    Effect.catch((error) =>
      Effect.logError(`Health check: ${dependency} unavailable`, error).pipe(Effect.as(false)),
    ),
  );

const ping = sql`select 1`;

const noStore = { headers: { "cache-control": "no-store" } };
