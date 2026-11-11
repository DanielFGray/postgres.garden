import { expect, layer } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";
import { sql } from "kysely";
import { DatabaseLive, PgRootDB, type DbHandle } from "../db.js";
import { asUser, deleteUser, randomSuffix } from "../testSupport.js";

/**
 * Each test creates an unverified address, as sign-up does, and takes the
 * token from the verification job it queued: the database keeps only the
 * token's hash. No worker runs against the test database, so the job stays in
 * the table to be read.
 */
layer(DatabaseLive, { timeout: "30 seconds" })("app_public.verify_email", (it) => {
  it.effect("verifies the address with the mailed token alone, once", () =>
    withUnverifiedAddress("verify_valid", ({ emailId, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        expect(yield* verifyEmail(db, token)).toBe(true);
        expect(yield* address(db, emailId)).toEqual({
          is_verified: true,
          verification_token_hash: null,
        });
        expect(yield* verifyEmail(db, token)).toBe(false);
      }),
    ),
  );

  it.effect("rejects the mailed token once it is older than 24 hours", () =>
    withUnverifiedAddress("verify_expired", ({ emailId, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        yield* db.all(
          db.connection
            .updateTable("app_private.user_email_secrets")
            .set({ verification_token_generated: sql`now() - interval '24 hours 1 minute'` })
            .where("user_email_id", "=", emailId),
        );
        expect(yield* verifyEmail(db, token)).toBe(false);
        expect((yield* address(db, emailId)).is_verified).toBe(false);
      }),
    ),
  );

  it.effect("keeps the mailed link alive when a resend comes within 3 minutes", () =>
    withUnverifiedAddress("verify_resend_early", ({ userId, emailId, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        expect(yield* resend(db, userId, emailId)).toBe(false);
        expect(yield* verificationTokens(db, emailId)).toEqual([token]);
        expect(yield* verifyEmail(db, token)).toBe(true);
      }),
    ),
  );

  it.effect("replaces the mailed link when a resend comes after 3 minutes", () =>
    withUnverifiedAddress("verify_resend_late", ({ userId, emailId, token }) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        yield* db.all(
          db.connection
            .updateTable("app_private.user_email_secrets")
            .set({ verification_token_generated: sql`now() - interval '3 minutes 1 second'` })
            .where("user_email_id", "=", emailId),
        );
        expect(yield* resend(db, userId, emailId)).toBe(true);
        const tokens = yield* verificationTokens(db, emailId);
        expect(tokens).toEqual([token, expect.any(String)]);
        const fresh = yield* Effect.fromOption(Arr.last(tokens));
        expect(yield* verifyEmail(db, token)).toBe(false);
        expect(yield* verifyEmail(db, fresh)).toBe(true);
      }),
    ),
  );
});

/**
 * Runs `test` with a new user whose only address is unverified, and the token
 * its verification job carries; removes the user and its jobs afterwards.
 */
const withUnverifiedAddress = <A, E, R>(
  name: string,
  test: (pending: { userId: string; emailId: string; token: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const db = yield* PgRootDB;
    const username = `${name}_${yield* randomSuffix}`;
    const user = yield* db.one(
      db.raw(sql<{ id: string }>`select id from app_private.really_create_user(
        username => ${username}::citext,
        email => ${`${username}@example.com`}::text,
        email_is_verified => false,
        password => ${"TestPassword123!"}::text
      )`),
    );
    const pending = db.one(
      db.raw(sql<{ emailId: string; token: string }>`
        select e.id as "emailId", j.payload->>'token' as token
        from app_public.user_emails e
        join graphile_worker._private_jobs j on j.payload->>'id' = e.id::text
        join graphile_worker._private_tasks t on t.id = j.task_id
        where t.identifier = 'user_emails__send_verification' and e.user_id = ${user.id}`),
    );
    const cleanUp = Effect.all([
      db.all(
        db.raw(sql`
          delete from graphile_worker._private_jobs
          where payload->>'id' in (select id::text from app_public.user_emails where user_id = ${user.id})`),
      ),
      deleteUser(db, user.id),
    ]).pipe(Effect.orDie);
    return yield* Effect.flatMap(pending, (found) => test({ userId: user.id, ...found })).pipe(
      Effect.ensuring(cleanUp),
    );
  });

const address = (db: DbHandle, emailId: string) =>
  db.one(
    db.connection
      .selectFrom("app_public.user_emails as address")
      .innerJoin("app_private.user_email_secrets as secrets", "secrets.user_email_id", "address.id")
      .select(["address.is_verified", "secrets.verification_token_hash"])
      .where("address.id", "=", emailId),
  );

const verifyEmail = (db: DbHandle, token: string) =>
  db
    .one(
      db.connection.selectNoFrom((eb) =>
        eb.fn<boolean>("app_public.verify_email", [eb.val(token)]).as("verify_email"),
      ),
    )
    .pipe(Effect.map((row) => row.verify_email));

/** Calls `resend_email_verification_code` as `userId`. */
const resend = (db: DbHandle, userId: string, emailId: string) =>
  asUser(db, userId, (visitor) =>
    visitor.one(
      visitor.raw(
        sql<{
          queued: boolean;
        }>`select app_public.resend_email_verification_code(${emailId}::uuid) as queued`,
      ),
    ),
  ).pipe(Effect.map((row) => row.queued));

/** The tokens of the verification jobs queued for `emailId`, oldest first. */
const verificationTokens = (db: DbHandle, emailId: string) =>
  db
    .all(
      db.raw(sql<{ token: string }>`
        select j.payload->>'token' as token
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
        where t.identifier = 'user_emails__send_verification' and j.payload->>'id' = ${emailId}
        order by j.id`),
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.token)));
