import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { sql } from "kysely";

import { PgRootDB } from "../server/db.js";
import { randomSuffix } from "../server/testSupport.js";
import { ExpiredPlaygrounds } from "./expiredPlaygrounds.js";

layer(Layer.provideMerge(ExpiredPlaygrounds.layer, PgRootDB.layer), { timeout: "30 seconds" })(
  "ExpiredPlaygrounds",
  (it) => {
    it.effect("deletes a playground with no account past its expiry, and keeps the rest", () =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        const suffix = yield* randomSuffix;
        const expired = `expired_${suffix}`;
        const live = `live_${suffix}`;
        yield* db.all(
          db.connection.insertInto("app_public.playgrounds").values([
            { hash: expired, expires_at: sql<Date>`now() - interval '1 minute'` },
            { hash: live, expires_at: sql<Date>`now() + interval '1 day'` },
          ]),
        );
        const left = db
          .all(
            db.connection
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
              .all(
                db.connection
                  .deleteFrom("app_public.playgrounds")
                  .where("hash", "in", [expired, live]),
              )
              .pipe(Effect.orDie),
          ),
        );
      }),
    );
  },
);
