/**
 * The private-playground entitlement, through each of its three callers.
 *
 * `app_public.may_have_private` is the rule. The trigger refuses a write that
 * breaks it, the insert_authenticated policy restates it for a write path that
 * does not go through a security definer function, and `fork_playground` reads
 * it as a choice. These tests pin the rule and the two callers whose answer is
 * observable: the trigger, and the fork's choice of level.
 */

import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import * as S from "effect/Schema";
import { sql } from "kysely";
import type { DatabaseError } from "@danielfgray/stompbox/db";
import { CurrentSession, type SessionData } from "../../shared/session.js";
import { DatabaseLive, type DB, type Queries } from "../db.js";
import { asVisitor, createUser, deleteUser, randomSuffix, withRoot } from "../testSupport.js";
import { dropPlayground } from "../test/playgrounds.js";

const randomUuid = SecureRandom.SecureRandom.use((random) => random.uuidV4());

/** Far enough ahead that the seeded session is live for the whole run. */
const sessionExpiry = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"));

const mayHavePrivate = (db: Queries<DB>, userId: string | null) =>
  db
    .one(S.Struct({ allowed: S.Boolean }), (k) =>
      k.selectNoFrom(sql<boolean>`app_public.may_have_private(${userId}::uuid)`.as("allowed")),
    )
    .pipe(Effect.map((row) => row.allowed));

const setRole = (db: Queries<DB>, userId: string, role: "user" | "sponsor") =>
  db.exec((k) => k.updateTable("app_public.users").set({ role }).where("id", "=", userId));

/** Writes a playground as the owner, so RLS is out of the way and only the trigger answers. */
const insertPlayground = (
  db: Queries<DB>,
  values: { hash: string; privacy: "private" | "secret" | "public"; user_id: string | null },
) => db.exec((k) => k.insertInto("app_public.playgrounds").values(values));

const readPrivacy = (db: Queries<DB>, hash: string) =>
  db
    .all(S.Struct({ privacy: S.String }), (k) =>
      k.selectFrom("app_public.playgrounds").select("privacy").where("hash", "=", hash),
    )
    .pipe(Effect.head);

/** What Postgres reported about a refused query: its code, and the message the database wrote. */
const refusal = (error: DatabaseError) => Effect.fromOption(error.report);

layer(Layer.mergeAll(DatabaseLive, NodeCrypto.layer), {
  excludeTestServices: true,
  timeout: "30 seconds",
})("the private-playground entitlement", (it) => {
  it.effect("refuses a private playground to an account without the entitlement", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* withRoot((db) => createUser(db, `ent_free_${suffix}`));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          expect(yield* withRoot((db) => mayHavePrivate(db, user.id))).toBe(false);

          const error = yield* Effect.flip(
            withRoot((db) =>
              insertPlayground(db, {
                hash: `entfree${suffix}`,
                privacy: "private",
                user_id: user.id,
              }),
            ),
          );

          const { code, message } = yield* refusal(error);
          expect(code).toBe("DNIED");
          expect(message).toContain("Private playgrounds require a sponsor account");
        }),
        withRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );

  it.effect("allows a private playground to a sponsor", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* withRoot((db) => createUser(db, `ent_sponsor_${suffix}`));
      const hash = `entspon${suffix}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* withRoot((db) => setRole(db, user.id, "sponsor"));
          expect(yield* withRoot((db) => mayHavePrivate(db, user.id))).toBe(true);

          yield* withRoot((db) =>
            insertPlayground(db, { hash, privacy: "private", user_id: user.id }),
          );
          expect(yield* withRoot((db) => readPrivacy(db, hash))).toEqual({
            privacy: "private",
          });
        }),
        withRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );

  it.effect("refuses a private playground with no owner, and says why separately", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;

      // Nobody holds the entitlement, so there is no account to check: the
      // trigger answers anonymity before it asks about a role.
      expect(yield* withRoot((db) => mayHavePrivate(db, null))).toBe(false);

      const error = yield* Effect.flip(
        withRoot((db) =>
          insertPlayground(db, { hash: `entanon${suffix}`, privacy: "private", user_id: null }),
        ),
      );

      const { code, message } = yield* refusal(error);
      expect(code).toBe("DNIED");
      expect(message).toContain("Anonymous playgrounds cannot be private");
    }),
  );

  it.effect("gives a fork the most private level the forking account may have", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* withRoot((db) => createUser(db, `ent_fork_${suffix}`));
      const source = `entsrc${suffix}`;
      const sessionId = yield* randomUuid;
      const forked: Array<string> = [];

      yield* Effect.ensuring(
        Effect.gen(function* () {
          // fork_playground reads the forking account through
          // app_public.current_user_id(), which resolves a session row.
          yield* withRoot((db) =>
            db.exec((k) =>
              k.insertInto("app_private.sessions").values({
                id: sessionId,
                user_id: user.id,
                expires_at: sessionExpiry,
              }),
            ),
          );
          const asUser = Effect.provideService(CurrentSession, {
            user: {
              id: user.id,
              username: `ent_fork_${suffix}`,
              role: "user",
              is_verified: true,
            },
            session: {
              id: sessionId,
              cookie_id: `ent_fork_${suffix}`,
              user_id: user.id,
              expires_at: sessionExpiry,
            },
          } satisfies SessionData);

          // A public source with one commit: a fork copies the latest commit,
          // and refuses a source the caller may not read.
          yield* withRoot((db) =>
            insertPlayground(db, { hash: source, privacy: "public", user_id: null }).pipe(
              Effect.andThen(
                db.exec((k) =>
                  k.insertInto("app_public.playground_commits").values({
                    playground_hash: source,
                    message: "initial",
                    // JSON text goes through text: a string sent to a json parameter is encoded twice.
                    data: sql`${S.encodeSync(
                      S.fromJsonString(
                        S.Struct({
                          files: S.Array(S.Struct({ path: S.String, content: S.String })),
                        }),
                      ),
                    )({ files: [{ path: "a.sql", content: "select 1" }] })}::text::jsonb`,
                  }),
                ),
              ),
            ),
          );

          const fork = () =>
            asVisitor((db) =>
              db.one(S.Struct({ playground_hash: S.String }), (k) =>
                k
                  .selectFrom(
                    sql<{ playground_hash: string }>`app_public.fork_playground(${source})`.as("f"),
                  )
                  .selectAll(),
              ),
            ).pipe(
              asUser,
              Effect.tap((row) => Effect.sync(() => forked.push(row.playground_hash))),
              Effect.flatMap((row) => withRoot((db) => readPrivacy(db, row.playground_hash))),
            );

          // A free account cannot hold a private playground, so its fork is
          // unlisted instead of refused.
          expect(yield* fork()).toEqual({ privacy: "secret" });

          yield* withRoot((db) => setRole(db, user.id, "sponsor"));
          expect(yield* fork()).toEqual({ privacy: "private" });
        }),
        Effect.gen(function* () {
          yield* Effect.forEach(forked, (hash) => withRoot((db) => dropPlayground(db, hash)));
          yield* withRoot((db) => dropPlayground(db, source));
          yield* withRoot((db) => deleteUser(db, user.id));
        }).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );
});
