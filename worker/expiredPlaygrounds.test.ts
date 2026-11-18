import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { sql } from "kysely";

import { PgRootDB, queriesOn, type DB } from "../server/db.js";
import { randomSuffix } from "../server/testSupport.js";
import { ExpiredPlaygrounds } from "./expiredPlaygrounds.js";

layer(Layer.provideMerge(ExpiredPlaygrounds.layer, PgRootDB.layer), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("ExpiredPlaygrounds", (it) => {
  it.effect("deletes a playground with no account past its expiry, and keeps the rest", () =>
    Effect.gen(function* () {
      const db = queriesOn<DB>(yield* PgRootDB);
      const suffix = yield* randomSuffix;
      const expired = `expired_${suffix}`;
      const live = `live_${suffix}`;
      yield* db.exec((k) =>
        k.insertInto("app_public.playgrounds").values([
          { hash: expired, expires_at: sql<Date>`now() - interval '1 minute'` },
          { hash: live, expires_at: sql<Date>`now() + interval '1 day'` },
        ]),
      );
      const left = db
        .all(Schema.Struct({ hash: Schema.String }), (k) =>
          k
            .selectFrom("app_public.playgrounds")
            .select("hash")
            .where("hash", "in", [expired, live]),
        )
        .pipe(Effect.map((rows) => rows.map((row) => row.hash)));
      const prune = Effect.gen(function* () {
        yield* (yield* ExpiredPlaygrounds).prune();
        expect(yield* left).toEqual([live]);
      });
      yield* prune.pipe(
        Effect.ensuring(
          db
            .exec((k) =>
              k.deleteFrom("app_public.playgrounds").where("hash", "in", [expired, live]),
            )
            .pipe(Effect.orDie),
        ),
      );
    }),
  );
});
