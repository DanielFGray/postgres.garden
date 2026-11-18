import { Context, Effect, Layer, Schema } from "effect";
import { sql } from "kysely";

import { PgRootDB, queriesOn, type DB } from "../server/db.js";

/**
 * Deletes the playgrounds with no account whose expiry has passed. The crontab
 * queues `prune_expired_playgrounds` once a day.
 */
export class ExpiredPlaygrounds extends Context.Service<ExpiredPlaygrounds>()(
  "postgres-garden/expiredPlaygrounds",
  {
    make: Effect.gen(function* () {
      const db = queriesOn<DB>(yield* PgRootDB);
      return {
        prune: Effect.fn("ExpiredPlaygrounds.prune")(function* () {
          const { deleted_count } = yield* db.one(
            Schema.Struct({ deleted_count: Schema.Finite }),
            (k) =>
              k
                .selectFrom(
                  sql<{
                    deleted_count: number;
                  }>`app_private.prune_expired_playgrounds()`.as("pruned"),
                )
                .select("deleted_count"),
          );
          if (deleted_count > 0) {
            yield* Effect.logInfo(`Deleted ${deleted_count} expired playgrounds`);
          }
        }),
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(PgRootDB.layer));
}

/** A crontab job's payload holds only graphile's `_cron` field, which the job does not read. */
export const PruneExpiredPlaygrounds = Schema.Struct({});
