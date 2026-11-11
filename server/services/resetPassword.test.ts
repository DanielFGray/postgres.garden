import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { sql } from "kysely";
import { DatabaseLive, PgRootDB, type DbHandle } from "../db.js";
import { createUser, deleteUser, randomSuffix } from "../testSupport.js";

const userSecrets = (db: DbHandle, userId: string) =>
  db
    .all(
      db.connection
        .selectFrom("app_private.user_secrets")
        .selectAll()
        .where("user_id", "=", userId),
    )
    .pipe(Effect.head);

/** Stores `token` as the pending reset, generated `age` ago (a Postgres interval). */
const setPendingReset = (db: DbHandle, userId: string, token: string, age = "0 seconds") =>
  db.all(
    db.connection
      .updateTable("app_private.user_secrets")
      .set({
        reset_password_token: token,
        reset_password_token_generated: sql`now() - ${age}::interval`,
      })
      .where("user_id", "=", userId),
  );

const resetPassword = (db: DbHandle, userId: string, token: string) =>
  db
    .all(
      db.connection.selectNoFrom((eb) =>
        eb
          .fn<boolean>("app_private.reset_password", [
            sql`${userId}::uuid`,
            eb.val(token),
            eb.val("NewPassword123!"),
          ])
          .as("reset_password"),
      ),
    )
    .pipe(
      Effect.head,
      Effect.map((row) => row.reset_password),
    );

layer(DatabaseLive, { timeout: "30 seconds" })("app_private.reset_password", (it) => {
  it.effect("rejects every token for a user with no pending reset", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* PgRootDB.use((rootDb) => createUser(rootDb, `reset_null_${suffix}`));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const before = yield* PgRootDB.use((rootDb) => userSecrets(rootDb, user.id));
          const result = yield* PgRootDB.use((rootDb) =>
            resetPassword(rootDb, user.id, "guessed-token"),
          );
          const after = yield* PgRootDB.use((rootDb) => userSecrets(rootDb, user.id));

          expect(result).toBeNull();
          expect(after.password_hash).toBe(before.password_hash);
          expect(after.failed_reset_password_attempts).toBe(1);
        }),
        PgRootDB.use((rootDb) => deleteUser(rootDb, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );

  it.effect("accepts the pending token and clears it on use", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* PgRootDB.use((rootDb) => createUser(rootDb, `reset_valid_${suffix}`));
      const token = `token_${suffix}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* PgRootDB.use((rootDb) => setPendingReset(rootDb, user.id, token));
          const result = yield* PgRootDB.use((rootDb) => resetPassword(rootDb, user.id, token));
          const after = yield* PgRootDB.use((rootDb) => userSecrets(rootDb, user.id));

          expect(result).toBe(true);
          expect(after.reset_password_token).toBeNull();
        }),
        PgRootDB.use((rootDb) => deleteUser(rootDb, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );

  it.effect("rejects the pending token once it is older than 3 days", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const user = yield* PgRootDB.use((rootDb) => createUser(rootDb, `reset_expired_${suffix}`));
      const token = `token_${suffix}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* PgRootDB.use((rootDb) =>
            setPendingReset(rootDb, user.id, token, "3 days 1 minute"),
          );
          const before = yield* PgRootDB.use((rootDb) => userSecrets(rootDb, user.id));
          const result = yield* PgRootDB.use((rootDb) => resetPassword(rootDb, user.id, token));
          const after = yield* PgRootDB.use((rootDb) => userSecrets(rootDb, user.id));

          expect(result).toBeNull();
          expect(after.password_hash).toBe(before.password_hash);
        }),
        PgRootDB.use((rootDb) => deleteUser(rootDb, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );
});
