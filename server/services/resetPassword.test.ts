import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { sql } from "kysely";
import { DatabaseLive, PgRootDB, type DbHandle } from "../db.js";
import { createUser, deleteUser, randomSuffix } from "../testSupport.js";

/**
 * Each test asks for a reset through `app_public.forgot_password`, as the app
 * does, and takes the token from the job it queued: the database keeps only
 * the token's hash. No worker runs against the test database, so the job stays
 * in the table to be read.
 */
layer(DatabaseLive, { timeout: "30 seconds" })("app_private.reset_password", (it) => {
  it.effect("accepts the mailed token alone, once, and stores only its hash", () =>
    withPendingReset("reset_valid", ({ user, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        const pending = yield* userSecrets(db, user.id);
        expect(pending.reset_password_token_hash).toBe(yield* sha256(db, token));

        expect(yield* resetPassword(db, token)).toBe(true);
        const after = yield* userSecrets(db, user.id);
        expect(after.password_hash).not.toBe(pending.password_hash);
        expect(after.reset_password_token_hash).toBeNull();

        expect(yield* resetPassword(db, token)).toBeNull();
      }),
    ),
  );

  it.effect("rejects a token that matches no pending reset", () =>
    withPendingReset("reset_guess", ({ user, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        const before = yield* userSecrets(db, user.id);
        const guess = token.replace(/^./, (digit) => (digit === "0" ? "1" : "0"));

        expect(yield* resetPassword(db, guess)).toBeNull();
        expect(yield* resetPassword(db, "not-hex")).toBeNull();
        expect(yield* userSecrets(db, user.id)).toEqual(before);
      }),
    ),
  );

  it.effect("rejects the mailed token once it is older than 1 hour", () =>
    withPendingReset("reset_expired", ({ user, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        yield* db.all(
          db.connection
            .updateTable("app_private.user_secrets")
            .set({ reset_password_token_generated: sql`now() - interval '1 hour 1 minute'` })
            .where("user_id", "=", user.id),
        );
        const before = yield* userSecrets(db, user.id);

        expect(yield* resetPassword(db, token)).toBeNull();
        const after = yield* userSecrets(db, user.id);
        expect(after.password_hash).toBe(before.password_hash);
        expect(after.failed_reset_password_attempts).toBe(1);
      }),
    ),
  );
});

/**
 * Runs `test` with a new user whose reset is pending, and the token that
 * `forgot_password` queued for it; removes the user and its jobs afterwards.
 */
const withPendingReset = <A, E, R>(
  name: string,
  test: (pending: { user: { id: string }; token: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const db = yield* PgRootDB;
    const username = `${name}_${yield* randomSuffix}`;
    const email = `${username}@example.com`;
    const user = yield* createUser(db, username);
    const cleanUp = Effect.all([
      db.all(
        db.raw(sql`delete from graphile_worker._private_jobs where payload->>'email' = ${email}`),
      ),
      deleteUser(db, user.id),
    ]).pipe(Effect.orDie);
    return yield* Effect.gen(function* () {
      yield* db.all(db.raw(sql`select app_public.forgot_password(${email}::citext)`));
      const { token } = yield* db.one(
        db.raw(sql<{ token: string }>`
          select j.payload->>'token' as token
          from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier = 'user__forgot_password' and j.payload->>'email' = ${email}`),
      );
      return yield* test({ user, token });
    }).pipe(Effect.ensuring(cleanUp));
  });

const userSecrets = (db: DbHandle, userId: string) =>
  db.one(
    db.connection.selectFrom("app_private.user_secrets").selectAll().where("user_id", "=", userId),
  );

const sha256 = (db: DbHandle, token: string) =>
  db
    .one(
      db.raw(sql<{ hash: string }>`select encode(sha256(decode(${token}, 'hex')), 'hex') as hash`),
    )
    .pipe(Effect.map((row) => row.hash));

const resetPassword = (db: DbHandle, token: string) =>
  db
    .one(
      db.connection.selectNoFrom((eb) =>
        eb
          .fn<boolean>("app_private.reset_password", [eb.val(token), eb.val("NewPassword123!")])
          .as("reset_password"),
      ),
    )
    .pipe(Effect.map((row) => row.reset_password));
