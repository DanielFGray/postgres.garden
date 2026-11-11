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
import { type DbHandle, type PublicDB } from "./db.js";
import { RequestDatabase, withAuthContext } from "./requestDatabase.js";
import { CurrentSession } from "../shared/session.js";

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

/**
 * Runs `use` as the visitor of the `CurrentSession` the caller provides, in one
 * transaction, the way a handler runs a service call.
 */
export const asVisitor = <A, E, R>(use: (db: DbHandle<PublicDB>) => Effect.Effect<A, E, R>) =>
  withAuthContext(RequestDatabase.use(use));

/**
 * Runs `use` as the visitor signed in as `userId`, through a session row that
 * exists only for the call. The sessions table has no foreign key to users,
 * so the row is removed here, not by `deleteUser`.
 */
export const asUser = <A, E, R>(
  root: DbHandle,
  userId: string,
  use: (db: DbHandle<PublicDB>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const user = yield* root.one(
      root.connection
        .selectFrom("app_public.users")
        .select(["id", "username", "role", "is_verified"])
        .where("id", "=", userId),
    );
    const cookieId = `test_${yield* randomSuffix}`;
    const session = yield* root.one(
      root.connection
        .insertInto("app_private.sessions")
        .values({ id: cookieId, user_id: userId, expires_at: sql`now() + interval '1 hour'` })
        .returning(["id", "user_id", "expires_at"])
        .$narrowType<{ expires_at: Date }>(),
    );
    return yield* asVisitor(use).pipe(
      Effect.provideService(CurrentSession, {
        user,
        session: { ...session, cookie_id: cookieId },
      }),
      Effect.ensuring(
        root
          .all(root.connection.deleteFrom("app_private.sessions").where("id", "=", session.id))
          .pipe(Effect.orDie),
      ),
    );
  });

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
