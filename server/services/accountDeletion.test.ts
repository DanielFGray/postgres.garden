import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { sql } from "kysely";
import { DatabaseLive, PgRootDB, type DbHandle } from "../db.js";
import { asUser, createUser, deleteUser, randomSuffix } from "../testSupport.js";

/**
 * Each test asks for the deletion as the signed-in user, as the account
 * settings do, and takes the token from the job that mails it: the database
 * keeps only the token's hash. No worker runs against the test database, so
 * the job stays in the table to be read.
 */
layer(DatabaseLive, { excludeTestServices: true, timeout: "30 seconds" })(
  "account deletion",
  (it) => {
    it.effect("deletes the account with the mailed token, and stores only its hash", () =>
      withUsers("delete_valid", ([user]) =>
        Effect.gen(function* () {
          const db = yield* PgRootDB;
          const token = yield* requestDeletion(db, user);
          expect((yield* userSecrets(db, user.id)).delete_account_token_hash).toBe(
            yield* sha256(db, token),
          );

          expect(yield* confirmDeletion(db, user.id, token)).toBe(true);
          expect(yield* userExists(db, user.id)).toBe(false);
        }),
      ),
    );

    it.effect("refuses a wrong token, and another account's token", () =>
      withUsers("delete_refused", ([owner, other]) =>
        Effect.gen(function* () {
          const db = yield* PgRootDB;
          const token = yield* requestDeletion(db, owner);
          const guess = token.replace(/^./, (digit) => (digit === "0" ? "1" : "0"));

          expect(yield* refusal(confirmDeletion(db, owner.id, guess))).toEqual(
            Option.some("DNIED"),
          );
          expect(yield* refusal(confirmDeletion(db, other.id, token))).toEqual(
            Option.some("DNIED"),
          );
          expect(yield* userExists(db, owner.id)).toBe(true);
          expect(yield* userExists(db, other.id)).toBe(true);
        }),
      ),
    );

    it.effect("refuses the mailed token once it is older than 1 hour", () =>
      withUsers("delete_expired", ([user]) =>
        Effect.gen(function* () {
          const db = yield* PgRootDB;
          const token = yield* requestDeletion(db, user);
          yield* db.all(
            db.connection
              .updateTable("app_private.user_secrets")
              .set({ delete_account_token_generated: sql`now() - interval '1 hour 1 minute'` })
              .where("user_id", "=", user.id),
          );

          expect(yield* refusal(confirmDeletion(db, user.id, token))).toEqual(Option.some("DNIED"));
          expect(yield* userExists(db, user.id)).toBe(true);
        }),
      ),
    );
  },
);

type TestUser = { readonly id: string; readonly email: string };

/**
 * Runs `test` with two new users, and removes them and their deletion jobs
 * afterwards. A test that deletes a user leaves nothing to remove.
 */
const withUsers = <A, E, R>(
  name: string,
  test: (users: readonly [TestUser, TestUser]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const db = yield* PgRootDB;
    const suffix = yield* randomSuffix;
    const make = (role: string) =>
      createUser(db, `${name}_${role}_${suffix}`).pipe(
        Effect.map(({ id }) => ({ id, email: `${name}_${role}_${suffix}@example.com` })),
      );
    const users = [yield* make("owner"), yield* make("other")] as const;
    const cleanUp = Effect.forEach(users, (user) =>
      Effect.all([
        db.all(
          db.raw(
            sql`delete from graphile_worker._private_jobs where payload->>'email' = ${user.email}`,
          ),
        ),
        deleteUser(db, user.id),
      ]),
    ).pipe(Effect.orDie);
    return yield* test(users).pipe(Effect.ensuring(cleanUp));
  });

/** Asks for the deletion as `user`, and returns the token its mail job carries. */
const requestDeletion = (db: DbHandle, user: TestUser) =>
  asUser(db, user.id, (visitor) =>
    visitor.all(visitor.raw(sql`select app_public.request_account_deletion()`)),
  ).pipe(
    Effect.andThen(
      db.one(
        db.raw(sql<{ token: string }>`
          select j.payload->>'token' as token
          from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
          where t.identifier = 'user__send_delete_account_email'
            and j.payload->>'email' = ${user.email}`),
      ),
    ),
    Effect.map((row) => row.token),
  );

const confirmDeletion = (db: DbHandle, userId: string, token: string) =>
  asUser(db, userId, (visitor) =>
    visitor.one(
      visitor.raw(
        sql<{ deleted: boolean }>`select app_public.confirm_account_deletion(${token}) as deleted`,
      ),
    ),
  ).pipe(Effect.map((row) => row.deleted));

/** The SQLSTATE `effect` failed with. */
const refusal = <A, R>(
  effect: Effect.Effect<A, { readonly report: Option.Option<{ readonly code: string }> }, R>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => Option.map(error.report, (report) => report.code)),
  );

const userExists = (db: DbHandle, userId: string) =>
  db
    .maybe(db.connection.selectFrom("app_public.users").select("id").where("id", "=", userId))
    .pipe(Effect.map(Option.isSome));

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
