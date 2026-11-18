import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { type Selectable, sql } from "kysely";
import type { DatabaseError } from "@danielfgray/stompbox/db";
import { PgRootDB, queriesOn, type DB } from "../db.js";
import type { AppPublicUsers } from "../../generated/db.js";
import { UserRow } from "../rows.js";
import { CurrentSession } from "../../shared/session.js";
import { recordActiveSessions, recordAuthAttempt } from "../metrics.js";
import { Cookies } from "./cookies.js";
import { Sessions } from "./sessions.js";

export class InvalidCredentialsError extends S.TaggedError<
  InvalidCredentialsError,
  { readonly brand: unique symbol }
>()("InvalidCredentials", {
  message: S.String,
}) {}

/** The SQLSTATE of a refused query, for the attempt counter. */
const refusalCode = (error: DatabaseError) => Option.map(error.report, (report) => report.code);

/**
 * Password sign-up, sign-in and sign-out. Each one writes or expires the
 * session cookie on the response in progress and records the attempt.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class Auth extends Context.Service<Auth>()("postgres-garden/auth", {
  make: Effect.gen(function* () {
    const root = queriesOn<DB>(yield* PgRootDB);
    const sessions = yield* Sessions;
    const cookies = yield* Cookies;

    /** Records the attempt, counts the new session and hands the caller its cookie. */
    const signedIn = (
      action: "register" | "login",
      { token, expiresAt }: { readonly token: string; readonly expiresAt: Date },
    ) =>
      recordAuthAttempt({ method: "password", action, result: "success" }).pipe(
        Effect.andThen(recordActiveSessions(1)),
        Effect.andThen(cookies.setSession(token, expiresAt)),
      );

    return {
      register: Effect.fn("Auth.register")(
        function* ({
          username,
          email,
          password,
          verified = false,
          name = null,
          avatarUrl = null,
        }: {
          username: string;
          email: string;
          password: string;
          verified?: boolean;
          name?: string | null;
          avatarUrl?: string | null;
        }) {
          const user = yield* root.one(UserRow, (k) =>
            k
              .selectFrom(
                sql<Selectable<AppPublicUsers>>`
                      app_private.really_create_user(
                      username => ${username}::citext,
                      email => ${email || null},
                      email_is_verified => ${verified},
                      name => ${name},
                      avatar_url => ${avatarUrl},
                      password => ${password}::text
                      )`.as("u"),
              )
              .selectAll()
              // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
          );

          const { token, expiresAt } = yield* sessions
            .createSession(user.id)
            .pipe(
              Effect.catchTag("NoSuchElementError", () =>
                Effect.die(new Error(`Newly registered user not found: ${user.id}`)),
              ),
            );
          return { user, token, expiresAt };
        },
        // The session cache write failed: no answer the client can act on.
        Effect.catchTag("RedisError", Effect.die),
        Effect.tap((result) => signedIn("register", result)),
        Effect.map(({ user }) => user),
        Effect.tapErrorTag("DatabaseError", (e) =>
          recordAuthAttempt({
            method: "password",
            action: "register",
            result: Option.contains(refusalCode(e), "23505") ? "duplicate" : "error",
          }),
        ),
      ),

      login: Effect.fn("Auth.login")(
        function* ({ id, password }: { id: string; password: string }) {
          // A wrong password must not fail inside the boundary. `app_private.login`
          // records the failed attempt and then returns null, and a failure here would
          // roll that write back, so the lockout counter would never grow. Database
          // errors such as LOCKD must still fail, so the row is taken with `Arr.head`.
          const found = yield* root.maybe(UserRow, (k) =>
            k
              .selectFrom((eb) =>
                eb
                  .fn<Selectable<AppPublicUsers>>("app_private.login", [
                    sql`${id}::citext`,
                    eb.val(password),
                  ])
                  .as("u"),
              )
              .selectAll()
              // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
          );
          const user = yield* Effect.fromOption(found).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new InvalidCredentialsError({ message: "Invalid username or password" })),
            ),
          );

          const { token, expiresAt } = yield* sessions
            .createSession(user.id)
            .pipe(
              Effect.catchTag("NoSuchElementError", () =>
                Effect.fail(
                  new InvalidCredentialsError({ message: "Invalid username or password" }),
                ),
              ),
            );
          return { user, token, expiresAt };
        },
        Effect.catchTag("RedisError", Effect.die),
        Effect.tap((result) => signedIn("login", result)),
        Effect.map(({ user }) => user),
        Effect.tapErrorTag("InvalidCredentials", () =>
          recordAuthAttempt({ method: "password", action: "login", result: "invalid" }),
        ),
        Effect.tapErrorTag("DatabaseError", (e) =>
          Option.contains(refusalCode(e), "LOCKD")
            ? recordAuthAttempt({ method: "password", action: "login", result: "locked" })
            : Effect.void,
        ),
      ),

      logout: Effect.fn("Auth.logout")(
        function* () {
          const { session } = yield* CurrentSession;
          if (session) {
            yield* sessions.deleteSession(session.cookie_id);
          }
          yield* recordActiveSessions(-1);
          yield* cookies.expireSession;
          return { success: true as const };
        },
        // The session cache could not be read or cleared: nothing the client can act on.
        Effect.catchTags({ RedisError: Effect.die, SchemaError: Effect.die }),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Sessions.layer, Cookies.layer)),
  );
}
