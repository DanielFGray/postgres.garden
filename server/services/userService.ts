import { Effect, pipe, Schema as S } from "effect";
import { Model } from "@effect/sql";
import { type Selectable, sql } from "kysely";
import { PgAuthDB, PgRootDB, withAuthContext } from "../db.js";
import type { AppPublicUserEmails as UserEmail } from "../../generated/db.js";

export interface UpdateProfileInput {
  readonly username?: string;
  readonly name?: string | null;
  readonly bio?: string;
  readonly avatar_url?: string | null;
}

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

export class UserService extends Effect.Service<UserService>()("UserService", {
  effect: Effect.gen(function*() {
    const rootDb = yield* PgRootDB;
    const authDb = yield* PgAuthDB;

    return {
      requestAccountDeletion: (token: string | undefined) =>
        Effect.gen(function*() {
          if (!token) {
            return yield* rootDb
              .selectNoFrom((eb) =>
                eb
                  .fn<boolean>("app_public.request_account_deletion", [])
                  .as("request_account_deletion"),
              )
              .pipe(
                Effect.head,
                Effect.map((rows) => rows?.request_account_deletion === true),
              );
          }

          return yield* rootDb
            .selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.confirm_account_deletion", [eb.val(token)])
                .as("confirm_account_deletion"),
            )
            .pipe(
              Effect.head,
              Effect.map((rows) => rows?.confirm_account_deletion === true),
            );
        }),

      getProfile: (sessionId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.users")
            .selectAll()
            .where("id", "=", sql<string>`app_public.current_user_id()`)
            .pipe(Effect.head),
        ),

      updateProfile: (sessionId: string, input: UpdateProfileInput) =>
        withAuthContext(
          authDb,
          sessionId,
          pipe(
            authDb
              .updateTable("app_public.users")
              .where("id", "=", sql<string>`app_public.current_user_id()`),
            (q) => (input.username !== undefined ? q.set("username", input.username) : q),
            (q) => (input.name !== undefined ? q.set("name", input.name) : q),
            (q) => (input.bio !== undefined ? q.set("bio", input.bio) : q),
            (q) => (input.avatar_url !== undefined ? q.set("avatar_url", input.avatar_url) : q),
            (q) => q.returningAll().pipe(Effect.head),
          ),
        ),

      listEmails: (sessionId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.user_emails")
            .selectAll()
            .where("user_id", "=", sql<string>`app_public.current_user_id()`)
            .orderBy("is_primary", "desc")
            .orderBy("created_at", "asc"),
        ),

      addEmail: (sessionId: string, email: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .insertInto("app_public.user_emails")
            .values({ email })
            .returningAll()
            .pipe(Effect.head),
        ),

      deleteEmail: (sessionId: string, id: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .deleteFrom("app_public.user_emails")
            .where("id", "=", id)
            .returningAll()
            .pipe(Effect.head),
        ),

      listAuthentications: (sessionId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.user_authentications")
            .select(["id", "service", "identifier", "created_at"])
            .where("user_id", "=", sql<string>`app_public.current_user_id()`)
            .orderBy("created_at", "asc"),
        ),

      unlinkAuthentication: (sessionId: string, id: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .deleteFrom("app_public.user_authentications")
            .where("id", "=", id)
            .returningAll()
            .pipe(Effect.head),
        ),

      hasPassword: (sessionId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.users as u")
            .select((eb) => [
              eb.fn<boolean>("app_public.users_has_password", [sql`u.*`]).as("has_password"),
            ])
            .where("u.id", "=", sql<string>`app_public.current_user_id()`)
            .pipe(Effect.head),
        ),

      forgotPassword: (email: string) =>
        rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<void>("app_public.forgot_password", [sql`${email}::citext`])
              .as("forgot_password"),
          )
          .pipe(Effect.asVoid),

      resetPassword: (userId: string, token: string, password: string) =>
        rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_private.reset_password", [
                sql`${userId}::uuid`,
                eb.val(token),
                eb.val(password),
              ])
              .as("reset_password"),
          )
          .pipe(
            Effect.head,
            Effect.map((rows) => ({ success: rows?.reset_password === true })),
          ),

      changePassword: (sessionId: string, oldPassword: string, newPassword: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.change_password", [
                  eb.val(oldPassword),
                  eb.val(newPassword),
                ])
                .as("change_password"),
            )
            .pipe(
              Effect.head,
              Effect.map((rows) => ({ success: rows?.change_password === true })),
            ),
        ),

      verifyEmail: (emailId: string, token: string) =>
        rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.verify_email", [sql`${emailId}::uuid`, eb.val(token)])
              .as("verify_email"),
          )
          .pipe(
            Effect.head,
            Effect.map((rows) => ({ success: rows?.verify_email === true })),
          ),

      makeEmailPrimary: (sessionId: string, emailId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom((eb) =>
              eb
                .fn<Selectable<UserEmail>>("app_public.make_email_primary", [sql`${emailId}::uuid`])
                .as("make_email_primary"),
            )
            .selectAll()
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                Effect.dieMessage("Failed to make email primary"),
              ),
            ),
        ),

      resendEmailVerificationCode: (sessionId: string, emailId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.resend_email_verification_code", [sql`${emailId}::uuid`])
                .as("resend_email_verification_code"),
            )
            .pipe(
              Effect.head,
              Effect.map((row) => ({
                success: row?.resend_email_verification_code === true,
              })),
            ),
        ),
    } as const;
  }),
  dependencies: [PgRootDB.Live, PgAuthDB.Live],
  accessors: true,
}) { }

export const runUserService = <A, E>(effect: Effect.Effect<A, E, UserService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UserService.Default)));
