/**
 * An anonymous playground and the key that holds it, at the database boundary.
 *
 * The server mints the key and stores only its digest, so these tests work the
 * way the handlers do: hash a secret, pass the digest, and keep the plaintext
 * on this side.
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
import { Secrets } from "../secrets.js";
import { PlaygroundService } from "./playgroundService.js";
import { createUser, deleteUser, randomSuffix } from "../testSupport.js";

/** One row of `app_public.playground_commit_result`. */
interface CommitResultRow {
  readonly commit_id: string;
  readonly playground_hash: string;
  readonly parent_id: string | null;
  readonly message: string;
  readonly created_at: Date;
}

/** Far enough ahead that a seeded session is live for the whole run. */
const expiry = DateTime.toDate(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"));

const commitData = (content: string) => JSON.stringify({ files: [{ path: "a.sql", content }] });

/**
 * What the handlers call: a save that either starts a playground or adds to
 * one, with the digest of the caller's key when it has no account.
 */
const save = (
  db: KyselyDB,
  values: {
    name?: string | null;
    message: string;
    content: string;
    hash?: string | null;
    editKeyHash?: Buffer | null;
  },
) =>
  runQuery(
    db
      .selectFrom(
        sql<CommitResultRow>`app_public.create_playground_commit(
          p_playground_name => ${values.name ?? null},
          p_commit_message => ${values.message},
          p_commit_data => ${commitData(values.content)}::jsonb,
          p_playground_hash => ${values.hash ?? null},
          p_edit_key_hash => ${values.editKeyHash ?? null}::bytea
        )`.as("result"),
      )
      .selectAll(),
  ).pipe(
    Effect.head,
    // A function that answers with no rows did not fail, it misbehaved: this one
    // either returns a row or raises. Dying keeps the error channel to what the
    // database actually refuses.
    Effect.catchTag("NoSuchElementError", () =>
      Effect.die(new Error("create_playground_commit returned no rows")),
    ),
  );

const claim = (db: KyselyDB, hash: string, editKeyHash: Buffer) =>
  runQuery(
    db
      .selectFrom(
        sql<{
          hash: string;
          user_id: string | null;
          edit_key_hash: Buffer | null;
          expires_at: Date | null;
        }>`app_public.claim_playground(${hash}, ${editKeyHash}::bytea)`.as("claimed"),
      )
      .selectAll(),
  ).pipe(
    Effect.head,
    // A function that answers with no rows did not fail, it misbehaved: this one
    // either returns a row or raises. Dying keeps the error channel to what the
    // database actually refuses.
    Effect.catchTag("NoSuchElementError", () =>
      Effect.die(new Error("claim_playground returned no rows")),
    ),
  );

const readPlayground = (db: KyselyDB, hash: string) =>
  runQuery(
    db
      .selectFrom("app_public.playgrounds")
      .select(["hash", "name", "user_id", "edit_key_hash", "expires_at"])
      .where("hash", "=", hash),
  ).pipe(Effect.head);

const commitCount = (db: KyselyDB, hash: string) =>
  runQuery(
    db
      .selectFrom("app_public.playground_commits")
      .select((eb) => eb.fn.countAll<bigint>().as("commits"))
      .where("playground_hash", "=", hash),
  ).pipe(
    Effect.head,
    Effect.map((row) => Number(row.commits)),
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

/** Nobody is signed in, so `app_public.current_user_id()` resolves to null. */
const anonymous = Effect.provideService(CurrentSession, { user: null, session: null });

/** Runs `use` with an anonymous playground and its key, then removes the row. */
const withAnonymousPlayground = <A, E, R>(
  use: (held: {
    readonly hash: string;
    readonly key: string;
    readonly keyHash: Buffer;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const suffix = yield* randomSuffix;
    const key = yield* Secrets.use((secrets) => secrets.generate);
    const keyHash = yield* Secrets.use((secrets) => secrets.digest(key));

    const created = yield* asVisitor((db) =>
      save(db, {
        name: `anon-${suffix}`,
        message: "first",
        content: "select 1",
        editKeyHash: keyHash,
      }),
    ).pipe(anonymous);

    return yield* Effect.ensuring(
      use({ hash: created.playground_hash, key, keyHash }),
      asRoot((db) => dropPlayground(db, created.playground_hash)).pipe(Effect.asVoid, Effect.orDie),
    );
  });

layer(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, Secrets.layer), { timeout: "30 seconds" })(
  "an anonymous playground's edit key",
  (it) => {
    it.effect("stores the key's digest and keeps the name the author sent", () =>
      withAnonymousPlayground(({ hash, key, keyHash }) =>
        Effect.gen(function* () {
          const row = yield* asRoot((db) => readPlayground(db, hash));

          expect(row.user_id).toBeNull();
          expect(row.name).toMatch(/^anon-/);
          // The digest is what the row holds. The key itself exists only in
          // this test and, in the real flow, in the answer to the author.
          expect(row.edit_key_hash?.equals(keyHash)).toBe(true);
          expect(row.edit_key_hash?.toString("hex")).not.toContain(key);
          // An unclaimed playground is pruned, so the author has to be told
          // when it goes.
          expect(row.expires_at).toBeInstanceOf(Date);
        }),
      ),
    );

    it.effect("commits to the same playground when the key is presented again", () =>
      withAnonymousPlayground(({ hash, keyHash }) =>
        Effect.gen(function* () {
          const second = yield* asVisitor((db) =>
            save(db, {
              message: "second",
              content: "select 2",
              hash,
              editKeyHash: keyHash,
            }),
          ).pipe(anonymous);

          // The link the author holds stays the playground they are editing.
          expect(second.playground_hash).toBe(hash);
          expect(yield* asRoot((db) => commitCount(db, hash))).toBe(2);
        }),
      ),
    );

    it.effect("refuses a commit with the wrong key, and one with none", () =>
      withAnonymousPlayground(({ hash }) =>
        Effect.gen(function* () {
          const otherKeyHash = yield* Secrets.use((secrets) =>
            Effect.flatMap(secrets.generate, (secret) => secrets.digest(secret)),
          );

          const wrong = yield* Effect.flip(
            asVisitor((db) =>
              save(db, { message: "no", content: "select 3", hash, editKeyHash: otherKeyHash }),
            ).pipe(anonymous),
          );
          expect((yield* refusal(wrong)).code).toBe("DNIED");

          const none = yield* Effect.flip(
            asVisitor((db) => save(db, { message: "no", content: "select 3", hash })).pipe(
              anonymous,
            ),
          );
          expect((yield* refusal(none)).code).toBe("DNIED");

          expect(yield* asRoot((db) => commitCount(db, hash))).toBe(1);
        }),
      ),
    );

    it.effect("refuses to start a playground that nobody could come back to", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          asVisitor((db) => save(db, { message: "orphan", content: "select 1" })).pipe(anonymous),
        );

        const { code, message } = yield* refusal(error);
        expect(code).toBe("MODAT");
        expect(message).toContain("An anonymous playground needs an edit key");
      }),
    );

    it.effect("refuses a save larger than a playground with no account may hold", () =>
      Effect.gen(function* () {
        const keyHash = yield* Secrets.use((secrets) => secrets.digest("too-big"));
        const error = yield* Effect.flip(
          asVisitor((db) =>
            save(db, {
              message: "oversized",
              // The cap is on the stored commit, which is this content plus the
              // JSON around it.
              content: "x".repeat(1024 * 1024),
              editKeyHash: keyHash,
            }),
          ).pipe(anonymous),
        );

        const { code, message } = yield* refusal(error);
        expect(code).toBe("DNIED");
        expect(message).toContain("Storage limit exceeded");
      }),
    );

    it.effect("hands the playground to the account that presents the key", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;
        const user = yield* asRoot((db) => createUser(db, `claim_${suffix}`));
        const sessionId = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());

        yield* Effect.ensuring(
          withAnonymousPlayground(({ hash, keyHash }) =>
            Effect.gen(function* () {
              yield* asRoot((db) =>
                runQuery(
                  db.insertInto("app_private.sessions").values({
                    id: sessionId,
                    user_id: user.id,
                    expires_at: expiry,
                  }),
                ),
              );
              const asUser = Effect.provideService(CurrentSession, {
                user: {
                  id: user.id,
                  username: `claim_${suffix}`,
                  role: "user",
                  is_verified: true,
                },
                session: {
                  id: sessionId,
                  cookie_id: `claim_${suffix}`,
                  user_id: user.id,
                  expires_at: expiry,
                },
              } satisfies SessionData);

              const claimed = yield* asVisitor((db) => claim(db, hash, keyHash)).pipe(asUser);

              expect(claimed.user_id).toBe(user.id);
              // The key stops being the way in, and the row stops expiring.
              expect(claimed.edit_key_hash).toBeNull();
              expect(claimed.expires_at).toBeNull();

              // The owner's own save needs no key from here on.
              const third = yield* asVisitor((db) =>
                save(db, { message: "mine now", content: "select 4", hash }),
              ).pipe(asUser);
              expect(third.playground_hash).toBe(hash);
            }),
          ),
          asRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );

    it.effect("refuses a claim without the key", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;
        const user = yield* asRoot((db) => createUser(db, `noclaim_${suffix}`));
        const sessionId = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());

        yield* Effect.ensuring(
          withAnonymousPlayground(({ hash }) =>
            Effect.gen(function* () {
              yield* asRoot((db) =>
                runQuery(
                  db.insertInto("app_private.sessions").values({
                    id: sessionId,
                    user_id: user.id,
                    expires_at: expiry,
                  }),
                ),
              );
              const otherKeyHash = yield* Secrets.use((secrets) =>
                Effect.flatMap(secrets.generate, (secret) => secrets.digest(secret)),
              );

              const error = yield* Effect.flip(
                asVisitor((db) => claim(db, hash, otherKeyHash)).pipe(
                  Effect.provideService(CurrentSession, {
                    user: {
                      id: user.id,
                      username: `noclaim_${suffix}`,
                      role: "user",
                      is_verified: true,
                    },
                    session: {
                      id: sessionId,
                      cookie_id: `noclaim_${suffix}`,
                      user_id: user.id,
                      expires_at: expiry,
                    },
                  } satisfies SessionData),
                ),
              );

              expect((yield* refusal(error)).code).toBe("DNIED");
              expect((yield* asRoot((db) => readPlayground(db, hash))).user_id).toBeNull();
            }),
          ),
          asRoot((db) => deleteUser(db, user.id)).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );
  },
);

/**
 * The same flow through the service the handlers call, which is where the key
 * is minted and digested: a database test cannot tell whether the server hashes
 * the key it answered with.
 */
layer(
  PlaygroundService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, Secrets.layer)),
  ),
  { timeout: "30 seconds" },
)("saving without an account", (it) => {
  it.effect("answers a key, then takes that key as proof of a later save", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const created = yield* PlaygroundService.use((service) =>
        service.create({
          name: `svc-${suffix}`,
          message: "first",
          files: [{ path: "a.sql", content: "select 1" }],
        }),
      ).pipe(anonymous);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          expect(created.edit_key).not.toBeNull();
          // The author is told when an unclaimed playground goes.
          expect(created.expires_at).not.toBeNull();

          const second = yield* PlaygroundService.use((service) =>
            service.createCommit(null, created.playground_hash, {
              message: "second",
              files: [{ path: "a.sql", content: "select 2" }],
              edit_key: created.edit_key ?? undefined,
            }),
          ).pipe(anonymous);

          expect(second.playground_hash).toBe(created.playground_hash);
          expect(second.forked).toBe(false);

          // A save with no key reaches the same playground and is refused:
          // the key is the whole claim to it.
          const refused = yield* PlaygroundService.use((service) =>
            service.createCommit(null, created.playground_hash, {
              message: "third",
              files: [{ path: "a.sql", content: "select 3" }],
            }),
          ).pipe(
            anonymous,
            Effect.flip,
            // The save fails on the database refusing it. Any other failure
            // is a broken test, not a refusal to read.
            Effect.flatMap((error) =>
              error._tag === "DatabaseError" ? refusal(error) : Effect.die(error),
            ),
          );
          expect(refused.code).toBe("DNIED");
        }),
        asRoot((db) => dropPlayground(db, created.playground_hash)).pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      );
    }),
  );

  it.effect("hands the playground to an account that presents the answered key", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* asRoot((db) => createUser(db, `svc_claim_${suffix}`));
      const sessionId = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4());

      const created = yield* PlaygroundService.use((service) =>
        service.create({
          name: `svc-claim-${suffix}`,
          message: "first",
          files: [{ path: "a.sql", content: "select 1" }],
        }),
      ).pipe(anonymous);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* asRoot((db) =>
            runQuery(
              db.insertInto("app_private.sessions").values({
                id: sessionId,
                user_id: user.id,
                expires_at: expiry,
              }),
            ),
          );

          const claimed = yield* PlaygroundService.use((service) =>
            service.claim(created.playground_hash, created.edit_key ?? ""),
          ).pipe(
            Effect.provideService(CurrentSession, {
              user: {
                id: user.id,
                username: `svc_claim_${suffix}`,
                role: "user",
                is_verified: true,
              },
              session: {
                id: sessionId,
                cookie_id: `svc_claim_${suffix}`,
                user_id: user.id,
                expires_at: expiry,
              },
            } satisfies SessionData),
          );

          expect(claimed.user_id).toBe(user.id);
          expect(claimed.expires_at).toBeNull();
          // The answer carries what the contract promises and nothing the
          // key could be read out of.
          expect(claimed).not.toHaveProperty("edit_key_hash");
        }),
        Effect.gen(function* () {
          yield* asRoot((db) => dropPlayground(db, created.playground_hash));
          yield* asRoot((db) => deleteUser(db, user.id));
        }).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );
});
