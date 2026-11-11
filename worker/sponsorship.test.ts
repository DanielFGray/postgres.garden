import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { sql } from "kysely";

import { type DatabaseError, PgRootDB } from "../server/db.js";
import { randomSuffix } from "../server/testSupport.js";
import { Sponsorship, SponsorshipEvent } from "./sponsorship.js";

layer(Layer.provideMerge(Sponsorship.layer, PgRootDB.layer), { timeout: "30 seconds" })(
  "Sponsorship",
  (it) => {
    it.effect("makes a GitHub sponsor a sponsor, and a user again when it ends", () =>
      withSponsor("user", (login, role) =>
        Effect.gen(function* () {
          const sponsorship = yield* Sponsorship;
          yield* sponsorship.apply(yield* event("created", login));
          expect(yield* role).toBe("sponsor");
          yield* sponsorship.apply(yield* event("edited", login));
          expect(yield* role).toBe("sponsor");
          yield* sponsorship.apply(yield* event("cancelled", login));
          expect(yield* role).toBe("user");
        }),
      ),
    );

    it.effect("skips an event that names no sponsor", () =>
      Effect.gen(function* () {
        yield* (yield* Sponsorship).apply(yield* event("created", null));
      }),
    );

    it.effect("leaves an admin who sponsors an admin", () =>
      withSponsor("admin", (login, role) =>
        Effect.gen(function* () {
          const sponsorship = yield* Sponsorship;
          yield* sponsorship.apply(yield* event("created", login));
          yield* sponsorship.apply(yield* event("cancelled", login));
          expect(yield* role).toBe("admin");
        }),
      ),
    );
  },
);

/** A sponsorship event as GitHub sends it, decoded as the worker decodes it. */
const event = (action: string, login: string | null) =>
  Schema.decodeEffect(SponsorshipEvent)({
    action,
    sponsorship: { sponsor: login === null ? null : { login } },
  });

/**
 * Runs `test` with a user of `role` whose GitHub login is linked, and `role`
 * reads that user's role back. The user is removed afterwards.
 */
const withSponsor = <A, E>(
  role: "user" | "admin",
  test: (
    login: string,
    role: Effect.Effect<string, DatabaseError>,
  ) => Effect.Effect<A, E, Sponsorship | PgRootDB>,
) =>
  Effect.gen(function* () {
    const db = yield* PgRootDB;
    const login = `sponsor_${yield* randomSuffix}`;
    const { id } = yield* db.one(
      db.raw(sql<{ id: string }>`select id from app_private.really_create_user(
        username => ${login}::citext,
        email => ${`${login}@example.invalid`}::text,
        email_is_verified => true,
        role => ${role}::app_public.user_role
      )`),
    );
    yield* db.all(
      db.raw(
        sql`select app_private.link_or_register_user(${id}::uuid, 'github', ${login}, json_build_object('login', ${login}::text), '{}'::json)`,
      ),
    );
    const readRole = db
      .one(db.connection.selectFrom("app_public.users").select("role").where("id", "=", id))
      .pipe(Effect.map((row) => row.role));
    return yield* test(login, readRole).pipe(
      Effect.ensuring(
        db
          .all(db.connection.deleteFrom("app_public.users").where("id", "=", id))
          .pipe(Effect.orDie),
      ),
    );
  });
