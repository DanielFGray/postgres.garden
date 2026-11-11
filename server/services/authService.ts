import { Array as Arr, Context, Effect, Layer, Match, Schema as S } from "effect";
import pg from "pg";
import { sql } from "kysely";
import { PgRootDB, unwrapPgError } from "../db.js";
import type { AppPublicUsers } from "../../generated/db.js";
import { CurrentSession } from "../../shared/session.js";
import { recordActiveSessions, recordAuthAttempt } from "../metrics.js";
import { Cookies } from "./cookies.js";
import { SessionService } from "./sessionService.js";

export class AccountLockedError extends S.TaggedError<
  AccountLockedError,
  { readonly brand: unique symbol }
>()("AccountLocked", {
  message: S.String,
}) {}

export class WeakPasswordError extends S.TaggedError<
  WeakPasswordError,
  { readonly brand: unique symbol }
>()("WeakPassword", {
  message: S.String,
  requirements: S.optional(S.Array(S.String)),
}) {}

export class AuthenticationRequiredError extends S.TaggedError<
  AuthenticationRequiredError,
  { readonly brand: unique symbol }
>()("AuthenticationRequired", {
  message: S.String,
  action: S.String,
}) {}

export class InvalidCredentialsError extends S.TaggedError<
  InvalidCredentialsError,
  { readonly brand: unique symbol }
>()("InvalidCredentials", {
  message: S.String,
}) {}

export class MissingDataError extends S.TaggedError<
  MissingDataError,
  { readonly brand: unique symbol }
>()("MissingData", {
  message: S.String,
  field: S.Union([S.Literals(["email"]), S.Literals(["password"]), S.Literals(["username"])]),
}) {}

export class AccountAlreadyLinkedError extends S.TaggedError<
  AccountAlreadyLinkedError,
  { readonly brand: unique symbol }
>()("AccountAlreadyLinked", {
  message: S.String,
  service: S.String,
}) {}

export class DuplicateAccountError extends S.TaggedError<
  DuplicateAccountError,
  { readonly brand: unique symbol }
>()("DuplicateAccount", {
  message: S.String,
}) {}

const mapRegisterPgError = (
  dbErr: pg.DatabaseError,
): MissingDataError | WeakPasswordError | DuplicateAccountError | undefined =>
  Match.value(dbErr.code).pipe(
    Match.when(
      "MODAT",
      () =>
        new MissingDataError({
          message: dbErr.message,
          field: dbErr.message.toLowerCase().includes("email") ? "email" : "password",
        }),
    ),
    Match.when("WEAKP", () => new WeakPasswordError({ message: dbErr.message })),
    Match.when(
      "23505",
      () => new DuplicateAccountError({ message: "Username or email already exists" }),
    ),
    Match.orElse(() => undefined),
  );

/**
 * Password sign-up, sign-in and sign-out. Each one writes or expires the
 * session cookie on the response in progress and records the attempt.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class AuthService extends Context.Service<AuthService>()("AuthService", {
  make: Effect.gen(function* () {
    const root = yield* PgRootDB;
    const sessionService = yield* SessionService;
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
      register: Effect.fnUntraced(
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
          const user = yield* root
            .all(
              root.connection
                .selectFrom(
                  sql<AppPublicUsers>`
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
            )
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementError", () =>
                Effect.die(new Error("really_create_user returned no rows")),
              ),
            );

          const { token, expiresAt } = yield* sessionService
            .createSession(user.id)
            .pipe(
              Effect.catchTag("NoSuchElementError", () =>
                Effect.die(new Error(`Newly registered user not found: ${user.id}`)),
              ),
            );
          return { user, token, expiresAt };
        },
        Effect.catch((e) =>
          unwrapPgError(e).pipe(
            Effect.flatMap((dbErr) => {
              const mapped = dbErr ? mapRegisterPgError(dbErr) : undefined;
              return mapped ? Effect.fail(mapped) : Effect.die(e);
            }),
          ),
        ),
        Effect.tap((result) => signedIn("register", result)),
        Effect.map(({ user }) => user),
        Effect.tapErrorTag("DuplicateAccount", () =>
          recordAuthAttempt({ method: "password", action: "register", result: "duplicate" }),
        ),
        Effect.tapErrorTag(["MissingData", "WeakPassword"], () =>
          recordAuthAttempt({ method: "password", action: "register", result: "error" }),
        ),
      ),

      login: Effect.fnUntraced(
        function* ({ id, password }: { id: string; password: string }) {
          // A wrong password must not fail inside the boundary. `app_private.login`
          // records the failed attempt and then returns null, and a failure here would
          // roll that write back, so the lockout counter would never grow. Database
          // errors such as LOCKD must still fail, so the row is taken with `Arr.head`.
          const found = yield* root
            .all(
              root.connection
                .selectFrom((eb) =>
                  eb
                    .fn<AppPublicUsers>("app_private.login", [sql`${id}::citext`, eb.val(password)])
                    .as("u"),
                )
                .selectAll()
                // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
                .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
            )
            .pipe(Effect.map(Arr.head));
          const user = yield* Effect.fromOption(found).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new InvalidCredentialsError({ message: "Invalid username or password" })),
            ),
          );

          const { token, expiresAt } = yield* sessionService
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
        Effect.catchIf(
          (e) => !S.is(InvalidCredentialsError)(e),
          (e) =>
            unwrapPgError(e).pipe(
              Effect.flatMap((dbErr) =>
                dbErr?.code === "LOCKD"
                  ? Effect.fail(new AccountLockedError({ message: dbErr.message }))
                  : Effect.die(e),
              ),
            ),
        ),
        Effect.tap((result) => signedIn("login", result)),
        Effect.map(({ user }) => user),
        Effect.tapErrorTag("InvalidCredentials", () =>
          recordAuthAttempt({ method: "password", action: "login", result: "invalid" }),
        ),
        Effect.tapErrorTag("AccountLocked", () =>
          recordAuthAttempt({ method: "password", action: "login", result: "locked" }),
        ),
      ),

      logout: Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        if (session) {
          yield* sessionService.deleteSession(session.cookie_id);
        }
        yield* recordActiveSessions(-1);
        yield* cookies.expireSession;
        return { success: true as const };
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(SessionService.layer, Cookies.layer)),
  );
}
