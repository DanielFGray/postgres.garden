import { Effect, Match, Schema as S } from "effect";
import { Model } from "@effect/sql";
import pg from "pg";
import { sql } from "kysely";
import { rootQuerier } from "../db.js";
import { SessionService } from "./sessionService.js";

export class User extends Model.Class<User>("User")({
  id: Model.Generated(S.UUID),
  username: S.NonEmptyTrimmedString,
  name: S.NullOr(S.NonEmptyTrimmedString),
  avatar_url: S.NullOr(S.NonEmptyTrimmedString),
  bio: S.NullOr(S.NonEmptyTrimmedString),
  role: S.Union(S.Literal("user"), S.Literal("admin")),
  is_verified: S.Boolean,
  created_at: Model.Generated(S.Date),
  updated_at: Model.Generated(S.Date),
}) {}

export class AccountLockedError extends S.TaggedError<AccountLockedError>()("AccountLocked", {
  message: S.String,
}) {}

export class WeakPasswordError extends S.TaggedError<WeakPasswordError>()("WeakPassword", {
  message: S.String,
  requirements: S.optional(S.Array(S.String)),
}) {}

export class AuthenticationRequiredError extends S.TaggedError<AuthenticationRequiredError>()(
  "AuthenticationRequired",
  {
    message: S.String,
    action: S.String,
  },
) {}

export class InvalidCredentialsError extends S.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentials",
  {
    message: S.String,
  },
) {}

export class MissingDataError extends S.TaggedError<MissingDataError>()("MissingData", {
  message: S.String,
  field: S.Union(S.Literal("email"), S.Literal("password"), S.Literal("username")),
}) {}

export class AccountAlreadyLinkedError extends S.TaggedError<AccountAlreadyLinkedError>()(
  "AccountAlreadyLinked",
  {
    message: S.String,
    service: S.String,
  },
) {}

export class DuplicateAccountError extends S.TaggedError<DuplicateAccountError>()(
  "DuplicateAccount",
  {
    message: S.String,
  },
) {}

/** Unwrap @effect/sql SqlError to get the underlying pg.DatabaseError, if any. */
const ErrorCarrier = S.Struct({ cause: S.optional(S.Unknown) });
const DatabaseErrorSchema = S.instanceOf(pg.DatabaseError);

export const unwrapPgError = (cause: unknown): pg.DatabaseError | undefined => {
  const carrier = S.decodeUnknownEither(ErrorCarrier)(cause);
  const underlying = Match.value(carrier).pipe(
    Match.tags({ Left: () => cause, Right: ({ right }) => right.cause ?? cause }),
    Match.exhaustive,
  );
  return S.is(DatabaseErrorSchema)(underlying) ? underlying : undefined;
};

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

export class AuthService extends Effect.Service<AuthService>()("AuthService", {
  effect: Effect.gen(function* () {
    const runRoot = yield* rootQuerier;
    const sessionService = yield* SessionService;

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
          const user = yield* runRoot((rootDb) =>
            rootDb
              .selectFrom(
                sql<User>`
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
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null)))
              .pipe(
                Effect.head,
                Effect.catchTag("NoSuchElementException", () =>
                  Effect.die(new Error("really_create_user returned no rows")),
                ),
              ),
          );

          const { token, expiresAt } = yield* sessionService
            .createSession(user.id)
            .pipe(
              Effect.catchTag("NoSuchElementException", () =>
                Effect.die(new Error(`Newly registered user not found: ${user.id}`)),
              ),
            );
          return { user, token, expiresAt };
        },
        Effect.catchAll((e) => {
          const dbErr = unwrapPgError(e);
          const mapped = dbErr ? mapRegisterPgError(dbErr) : undefined;
          return mapped ? Effect.fail(mapped) : Effect.die(e);
        }),
      ),

      login: Effect.fnUntraced(
        function* ({ id, password }: { id: string; password: string }) {
          const user = yield* runRoot((rootDb) =>
            rootDb
              .selectFrom((eb) =>
                eb.fn<User>("app_private.login", [sql`${id}::citext`, eb.val(password)]).as("u"),
              )
              .selectAll()
              // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null)))
              .pipe(
                Effect.head,
                Effect.catchTag("NoSuchElementException", () =>
                  Effect.fail(
                    new InvalidCredentialsError({ message: "Invalid username or password" }),
                  ),
                ),
              ),
          );

          const { token, expiresAt } = yield* sessionService
            .createSession(user.id)
            .pipe(
              Effect.catchTag("NoSuchElementException", () =>
                Effect.fail(
                  new InvalidCredentialsError({ message: "Invalid username or password" }),
                ),
              ),
            );
          return { user, token, expiresAt };
        },
        Effect.catchAll((e): Effect.Effect<never, InvalidCredentialsError | AccountLockedError> => {
          if (S.is(InvalidCredentialsError)(e)) return Effect.fail(e);
          const dbErr = unwrapPgError(e);
          if (dbErr?.code === "LOCKD")
            return Effect.fail(new AccountLockedError({ message: dbErr.message }));
          return Effect.die(e);
        }),
      ),

      logout: (cookieId: string | undefined) =>
        Effect.gen(function* () {
          if (cookieId) {
            yield* sessionService.deleteSession(cookieId);
          }
          return { success: true as const };
        }),
    } as const;
  }),
  dependencies: [SessionService.Default],
  accessors: true,
}) {}
