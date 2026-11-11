/**
 * What the database-backed test suites share: a unique name, a user to own
 * rows, and a way to read back what an effect logged.
 *
 * Each suite seeds its own rows through `PgRootDB` and removes them again, so
 * these helpers take the Kysely handle the boundary hands out rather than
 * opening anything themselves.
 */

import { Effect, Logger, Random } from "effect";
import { sql } from "kysely";
import { type DbHandle } from "./db.js";

/** Unique enough to keep concurrent test rows apart. */
export const randomSuffix = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => n.toString(16).padStart(8, "0")),
);

/** A verified user with a known password, through the function the app uses. */
export const createUser = (db: DbHandle, username: string) =>
  db
    .all(
      db.connection
        .selectFrom(
          sql<{ id: string; role: string }>`app_private.really_create_user(
        username => ${username}::citext,
        email => ${`${username}@example.com`}::text,
        email_is_verified => true,
        password => ${"TestPassword123!"}::text
      )`.as("user"),
        )
        .selectAll(),
    )
    .pipe(Effect.head);

/** Removes the user and everything that cascades from it. */
export const deleteUser = (db: DbHandle, userId: string) =>
  db.all(db.connection.deleteFrom("app_public.users").where("id", "=", userId));

/**
 * Collects what `effect` logged, so a test can assert on an absent log line as
 * well as a present one.
 */
export const withCapturedLogs = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const lines: Array<string> = [];
  const result = yield* effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>(({ logLevel, message }) => {
          lines.push(`${logLevel}: ${String(message)}`);
        }),
      ]),
    ),
  );
  return { result, lines } as const;
});
