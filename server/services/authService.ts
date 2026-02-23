import { Effect, Schema as S } from "effect";
import { Model } from "@effect/sql";
import pg from "pg";
import { sql } from "kysely";
import { PgRootDB } from "../db.js";
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
}) { }

export class AccountLockedError extends S.TaggedError<AccountLockedError>()("AccountLocked", {
  message: S.String,
}) { }

export class WeakPasswordError extends S.TaggedError<WeakPasswordError>()("WeakPassword", {
  message: S.String,
  requirements: S.optional(S.Array(S.String)),
}) { }

export class AuthenticationRequiredError extends S.TaggedError<AuthenticationRequiredError>()("AuthenticationRequired", {
  message: S.String,
  action: S.String,
}) { }

export class InvalidCredentialsError extends S.TaggedError<InvalidCredentialsError>()("InvalidCredentials", {
  message: S.String,
}) { }

export class MissingDataError extends S.TaggedError<MissingDataError>()("MissingData", {
  message: S.String,
  field: S.Union(S.Literal("email"), S.Literal("password"), S.Literal("username")),
}) { }

export class AccountAlreadyLinkedError extends S.TaggedError<AccountAlreadyLinkedError>()("AccountAlreadyLinked", {
  message: S.String,
  service: S.String,
}) { }

export class DuplicateAccountError extends S.TaggedError<DuplicateAccountError>()("DuplicateAccount", {
  message: S.String,
}) { }

/** Unwrap @effect/sql SqlError to get the underlying pg.DatabaseError, if any. */
export const unwrapPgError = (e: unknown): pg.DatabaseError | undefined => {
  const cause = e && typeof e === "object" && "cause" in e
    ? (e as { cause: unknown }).cause
    : e;
  return cause instanceof pg.DatabaseError ? cause : undefined;
};

export class AuthService extends Effect.Service<AuthService>()("AuthService", {
  effect: Effect.gen(function*() {
    const rootDb = yield* PgRootDB;

    return {
      register: ({ username, email, password, verified = false, name = null, avatarUrl = null }: { username: string; email: string; password: string; verified?: boolean; name?: string | null; avatarUrl?: string | null; }) =>
        Effect.gen(function*() {
          const user = yield* rootDb
            .selectFrom(
              sql<typeof User.Type>`
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
            );

          const { token, expiresAt } = yield* SessionService.createSession(user.id);
          return { user, token, expiresAt };
        }).pipe(
          Effect.catchAll((e) => {
            const dbErr = unwrapPgError(e);
            const mapped = dbErr && ({
              MODAT: () => new MissingDataError({
                message: dbErr.message,
                field: dbErr.message.toLowerCase().includes("email") ? "email" : "password",
              }),
              WEAKP: () => new WeakPasswordError({ message: dbErr.message }),
              23505: () => new DuplicateAccountError({ message: "Username or email already exists" }),
            } as Record<string, () => MissingDataError | WeakPasswordError | DuplicateAccountError>)[dbErr.code ?? ""]?.();
            return mapped ? Effect.fail(mapped) : Effect.die(e);
          }),
        ),

      login: ({ id, password }: { id: string; password: string }) =>
        Effect.gen(function*() {
          const user = yield* rootDb.selectFrom((eb) =>
            eb
              .fn<typeof User.Type>("app_private.login", [sql`${id}::citext`, eb.val(password)])
              .as("u"),
          )
            .selectAll()
            // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
            .where((eb) => eb.not(eb(eb.ref("u"), "is", null)))
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                Effect.fail(new InvalidCredentialsError({ message: "Invalid username or password" })),
              ),
            );

          const { token, expiresAt } = yield* SessionService.createSession(user.id);
          return { user, token, expiresAt };
        }).pipe(
          Effect.catchAll((e): Effect.Effect<never, InvalidCredentialsError | AccountLockedError> => {
            if (e instanceof InvalidCredentialsError) return Effect.fail(e);
            const dbErr = unwrapPgError(e);
            if (dbErr?.code === "LOCKD") return Effect.fail(new AccountLockedError({ message: dbErr.message }));
            return Effect.die(e);
          }),
        ),

      logout: (cookieId: string | undefined) =>
        Effect.gen(function*() {
          if (cookieId) {
            yield* SessionService.deleteSession(cookieId);
          }
          return { success: true as const };
        }),
    } as const;
  }),
  dependencies: [PgRootDB.Live, SessionService.Default],
  accessors: true,
}) { }
