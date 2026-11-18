/**
 * What the database-backed test suites share: a unique name, a user to own
 * rows, and a way to read back what an effect logged.
 *
 * Each suite seeds its own rows through `PgRootDB` and removes them again, so
 * these helpers take the query runner of that pool rather than opening
 * anything themselves.
 */

import { Effect, Logger, Random } from "effect";
import * as S from "effect/Schema";
import { type Compilable, type Kysely, type RawBuilder, sql } from "kysely";
import { type DB, PgRootDB, type Queries, queriesOn } from "./db.js";
import { requestDb, withAuthContext } from "./requestDatabase.js";
import { CurrentSession, SessionUser } from "../shared/session.js";

/** The user fields a session carries, as `app_public.users` returns them. */
const SessionUserRow = S.toType(SessionUser);

/** Unique enough to keep concurrent test rows apart. */
export const randomSuffix = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => n.toString(16).padStart(8, "0")),
);

/** Runs `use` with the query runner of the owner-role pool. */
export const withRoot = <A, E, R>(use: (db: Queries<DB>) => Effect.Effect<A, E, R>) =>
  PgRootDB.use((pool) => use(queriesOn<DB>(pool)));

/**
 * A raw statement as a query builder, for what Kysely's typed builder cannot
 * name: tables of other schemas, `do` blocks and the like.
 */
export const rawQuery =
  <O>(statement: RawBuilder<O>) =>
  (k: Kysely<any>): Compilable<O> => ({ compile: () => statement.compile(k) });

/** A verified user with a known password, through the function the app uses. */
export const createUser = (db: Queries<DB>, username: string) =>
  db.one(S.Struct({ id: S.String, role: S.String }), (k) =>
    k
      .selectFrom(
        sql<{ id: string; role: string }>`app_private.really_create_user(
        username => ${username}::citext,
        email => ${`${username}@example.com`}::text,
        email_is_verified => true,
        password => ${"TestPassword123!"}::text
      )`.as("user"),
      )
      .selectAll(),
  );

/**
 * Runs `use` as the visitor of the `CurrentSession` the caller provides, in one
 * transaction, the way a handler runs a service call.
 */
export const asVisitor = <A, E, R>(use: (db: typeof requestDb) => Effect.Effect<A, E, R>) =>
  withAuthContext(Effect.suspend(() => use(requestDb)));

/**
 * Runs `use` as the visitor signed in as `userId`, through a session row that
 * exists only for the call. The sessions table has no foreign key to users,
 * so the row is removed here, not by `deleteUser`.
 */
export const asUser = <A, E, R>(
  root: Queries<DB>,
  userId: string,
  use: (db: typeof requestDb) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const user = yield* root.one(SessionUserRow, (k) =>
      k
        .selectFrom("app_public.users")
        .select(["id", "username", "role", "is_verified"])
        .where("id", "=", userId),
    );
    const cookieId = `test_${yield* randomSuffix}`;
    const session = yield* root.one(
      S.Struct({ id: S.String, user_id: S.String, expires_at: S.Date }),
      (k) =>
        k
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
          .exec((k) => k.deleteFrom("app_private.sessions").where("id", "=", session.id))
          .pipe(Effect.orDie),
      ),
    );
  });

/** Removes the user and everything that cascades from it. */
export const deleteUser = (db: Queries<DB>, userId: string) =>
  db.exec((k) => k.deleteFrom("app_public.users").where("id", "=", userId));

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
