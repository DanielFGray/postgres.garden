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
import { sql } from "kysely";
import { CurrentSession, type SessionData } from "../apiSchema.js";
import {
  asRoot,
  asVisitor,
  DatabaseLive,
  type DatabaseError,
  runQuery,
  unwrapPgError,
  type KyselyDB,
} from "../db.js";
import { createUser, deleteUser, randomSuffix } from "../testSupport.js";

const randomUuid = SecureRandom.SecureRandom.use((random) => random.uuidV4());

/** Far enough ahead that the seeded session is live for the whole run. */
const sessionExpiry = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"));

const mayHavePrivate = (db: KyselyDB, userId: string | null) =>
  runQuery(
    db.selectNoFrom(sql<boolean>`app_public.may_have_private(${userId}::uuid)`.as("allowed")),
  ).pipe(
    Effect.head,
    Effect.map((row) => row.allowed),
  );

const setRole = (db: KyselyDB, userId: string, role: "user" | "sponsor") =>
  runQuery(db.updateTable("app_public.users").set({ role }).where("id", "=", userId));

/** Writes a playground as the owner, so RLS is out of the way and only the trigger answers. */
const insertPlayground = (
  db: KyselyDB,
  values: { hash: string; privacy: "private" | "secret" | "public"; user_id: string | null },
) => runQuery(db.insertInto("app_public.playgrounds").values(values));

const readPrivacy = (db: KyselyDB, hash: string) =>
  runQuery(db.selectFrom("app_public.playgrounds").select("privacy").where("hash", "=", hash)).pipe(
    Effect.head,
  );

const dropPlayground = (db: KyselyDB, hash: string) =>
  runQuery(
    db.updateTable("app_public.playgrounds").set({ head_commit_id: null }).where("hash", "=", hash),
  ).pipe(
    Effect.andThen(
      runQuery(db.deleteFrom("app_public.playground_commits").where("playground_hash", "=", hash)),
    ),
    Effect.andThen(runQuery(db.deleteFrom("app_public.playgrounds").where("hash", "=", hash))),
  );

/** The pg error behind a failed query: its code, and the message the database wrote. */
const refusal = (error: DatabaseError) =>
  unwrapPgError(error).pipe(
    Effect.map((pgError) => ({ code: pgError?.code, message: pgError?.message ?? "" })),
  );

layer(Layer.mergeAll(DatabaseLive, NodeCrypto.layer), { timeout: "30 seconds" })(
  "the private-playground entitlement",
  (it) => {
    it.effect("refuses a private playground to an account without the entitlement", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;
        const user = yield* asRoot((db) => createUser(db, `ent_free_${suffix}`));

        yield* Effect.ensuring(
          Effect.gen(function* () {
            expect(yield* asRoot((db) => mayHavePrivate(db, user.id))).toBe(false);

            const error = yield* Effect.flip(
              asRoot((db) =>
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
          asRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );

    it.effect("allows a private playground to a sponsor", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;
        const user = yield* asRoot((db) => createUser(db, `ent_sponsor_${suffix}`));
        const hash = `entspon${suffix}`;

        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* asRoot((db) => setRole(db, user.id, "sponsor"));
            expect(yield* asRoot((db) => mayHavePrivate(db, user.id))).toBe(true);

            yield* asRoot((db) =>
              insertPlayground(db, { hash, privacy: "private", user_id: user.id }),
            );
            expect(yield* asRoot((db) => readPrivacy(db, hash))).toEqual({ privacy: "private" });
          }),
          asRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );

    it.effect("refuses a private playground with no owner, and says why separately", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;

        // Nobody holds the entitlement, so there is no account to check: the
        // trigger answers anonymity before it asks about a role.
        expect(yield* asRoot((db) => mayHavePrivate(db, null))).toBe(false);

        const error = yield* Effect.flip(
          asRoot((db) =>
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
        const user = yield* asRoot((db) => createUser(db, `ent_fork_${suffix}`));
        const source = `entsrc${suffix}`;
        const sessionId = yield* randomUuid;
        const forked: Array<string> = [];

        yield* Effect.ensuring(
          Effect.gen(function* () {
            // fork_playground reads the forking account through
            // app_public.current_user_id(), which resolves a session row.
            yield* asRoot((db) =>
              runQuery(
                db.insertInto("app_private.sessions").values({
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
            yield* asRoot((db) =>
              insertPlayground(db, { hash: source, privacy: "public", user_id: null }).pipe(
                Effect.andThen(
                  runQuery(
                    db.insertInto("app_public.playground_commits").values({
                      playground_hash: source,
                      message: "initial",
                      data: JSON.stringify({ files: [{ path: "a.sql", content: "select 1" }] }),
                    }),
                  ),
                ),
              ),
            );

            const fork = () =>
              asVisitor((db) =>
                runQuery(
                  db
                    .selectFrom(
                      sql<{ playground_hash: string }>`app_public.fork_playground(${source})`.as(
                        "f",
                      ),
                    )
                    .selectAll(),
                ),
              ).pipe(
                Effect.head,
                asUser,
                Effect.tap((row) => Effect.sync(() => forked.push(row.playground_hash))),
                Effect.flatMap((row) => asRoot((db) => readPrivacy(db, row.playground_hash))),
              );

            // A free account cannot hold a private playground, so its fork is
            // unlisted instead of refused.
            expect(yield* fork()).toEqual({ privacy: "secret" });

            yield* asRoot((db) => setRole(db, user.id, "sponsor"));
            expect(yield* fork()).toEqual({ privacy: "private" });
          }),
          Effect.gen(function* () {
            yield* Effect.forEach(forked, (hash) => asRoot((db) => dropPlayground(db, hash)));
            yield* asRoot((db) => dropPlayground(db, source));
            yield* asRoot((db) => deleteUser(db, user.id));
          }).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );
  },
);
