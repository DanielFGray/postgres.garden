import { Context, Effect, Layer } from "effect";
import { type Selectable, sql } from "kysely";
import { PgRootDB } from "../db.js";
import { RequestDatabase } from "../requestDatabase.js";
import type { AppPublicUserEmails as UserEmail } from "../../generated/db.js";

export interface UpdateProfileInput {
  readonly username?: string;
  readonly name?: string | null;
  readonly bio?: string;
  readonly avatar_url?: string | null;
}

export class UserService extends Context.Service<UserService>()("UserService", {
  make: Effect.gen(function* () {
    const root = yield* PgRootDB;
    return {
      requestAccountDeletion: Effect.fn("UserService.requestAccountDeletion")(function* (
        token: string | undefined,
      ) {
        if (!token) {
          return yield* RequestDatabase.use((db) =>
            db.one(
              db.connection.selectNoFrom((eb) =>
                eb
                  .fn<boolean>("app_public.request_account_deletion", [])
                  .as("request_account_deletion"),
              ),
            ),
          ).pipe(Effect.map((row) => row.request_account_deletion === true));
        }

        return yield* RequestDatabase.use((db) =>
          db.one(
            db.connection.selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.confirm_account_deletion", [eb.val(token)])
                .as("confirm_account_deletion"),
            ),
          ),
        ).pipe(Effect.map((row) => row.confirm_account_deletion === true));
      }),

      getProfile: Effect.fn("UserService.getProfile")(() =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .selectFrom("app_public.users")
              .selectAll()
              .where("id", "=", sql<string>`app_public.current_user_id()`),
          ),
        ).pipe(
          Effect.head,
          Effect.catchTag("NoSuchElementError", () => Effect.succeed(null)),
        ),
      ),

      updateProfile: Effect.fn("UserService.updateProfile")((input: UpdateProfileInput) =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .updateTable("app_public.users")
              .where("id", "=", sql<string>`app_public.current_user_id()`)
              .$if(input.username !== undefined, (q) => q.set("username", input.username!))
              .$if(input.name !== undefined, (q) => q.set("name", input.name!))
              .$if(input.bio !== undefined, (q) => q.set("bio", input.bio!))
              .$if(input.avatar_url !== undefined, (q) => q.set("avatar_url", input.avatar_url!))
              .returningAll(),
          ),
        ).pipe(Effect.head),
      ),

      listEmails: Effect.fn("UserService.listEmails")(() =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .selectFrom("app_public.user_emails")
              .selectAll()
              .where("user_id", "=", sql<string>`app_public.current_user_id()`)
              .orderBy("is_primary", "desc")
              .orderBy("created_at", "asc"),
          ),
        ),
      ),

      addEmail: Effect.fn("UserService.addEmail")((email: string) =>
        RequestDatabase.use((db) =>
          db.one(
            db.connection.insertInto("app_public.user_emails").values({ email }).returningAll(),
          ),
        ),
      ),

      deleteEmail: Effect.fn("UserService.deleteEmail")((id: string) =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection.deleteFrom("app_public.user_emails").where("id", "=", id).returningAll(),
          ),
        ).pipe(Effect.head),
      ),

      listAuthentications: Effect.fn("UserService.listAuthentications")(() =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .selectFrom("app_public.user_authentications")
              .select(["id", "service", "identifier", "created_at"])
              .where("user_id", "=", sql<string>`app_public.current_user_id()`)
              .orderBy("created_at", "asc"),
          ),
        ),
      ),

      unlinkAuthentication: Effect.fn("UserService.unlinkAuthentication")((id: string) =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .deleteFrom("app_public.user_authentications")
              .where("id", "=", id)
              .returningAll(),
          ),
        ).pipe(Effect.head),
      ),

      hasPassword: Effect.fn("UserService.hasPassword")(() =>
        RequestDatabase.use((db) =>
          db.all(
            db.connection
              .selectFrom("app_public.users as u")
              .select((eb) => [
                eb.fn<boolean>("app_public.users_has_password", [sql`u.*`]).as("has_password"),
              ])
              .where("u.id", "=", sql<string>`app_public.current_user_id()`),
          ),
        ).pipe(Effect.head),
      ),

      forgotPassword: Effect.fn("UserService.forgotPassword")((email: string) =>
        root
          .all(
            root.connection.selectNoFrom((eb) =>
              eb
                .fn<void>("app_public.forgot_password", [sql`${email}::citext`])
                .as("forgot_password"),
            ),
          )
          .pipe(Effect.asVoid),
      ),

      resetPassword: Effect.fn("UserService.resetPassword")(
        (userId: string, token: string, password: string) =>
          root
            .one(
              root.connection.selectNoFrom((eb) =>
                eb
                  .fn<boolean>("app_private.reset_password", [
                    sql`${userId}::uuid`,
                    eb.val(token),
                    eb.val(password),
                  ])
                  .as("reset_password"),
              ),
            )
            .pipe(Effect.map((row) => ({ success: row.reset_password === true }))),
      ),

      changePassword: Effect.fn("UserService.changePassword")(
        (oldPassword: string, newPassword: string) =>
          RequestDatabase.use((db) =>
            db.one(
              db.connection.selectNoFrom((eb) =>
                eb
                  .fn<boolean>("app_public.change_password", [
                    eb.val(oldPassword),
                    eb.val(newPassword),
                  ])
                  .as("change_password"),
              ),
            ),
          ).pipe(Effect.map((row) => ({ success: row.change_password === true }))),
      ),

      verifyEmail: Effect.fn("UserService.verifyEmail")((emailId: string, token: string) =>
        root
          .one(
            root.connection.selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.verify_email", [sql`${emailId}::uuid`, eb.val(token)])
                .as("verify_email"),
            ),
          )
          .pipe(Effect.map((row) => ({ success: row.verify_email === true }))),
      ),

      makeEmailPrimary: Effect.fn("UserService.makeEmailPrimary")((emailId: string) =>
        RequestDatabase.use((db) =>
          db.one(
            db.connection
              .selectFrom((eb) =>
                eb
                  .fn<Selectable<UserEmail>>("app_public.make_email_primary", [
                    sql`${emailId}::uuid`,
                  ])
                  .as("make_email_primary"),
              )
              .selectAll(),
          ),
        ),
      ),

      resendEmailVerificationCode: Effect.fn("UserService.resendEmailVerificationCode")(
        (emailId: string) =>
          RequestDatabase.use((db) =>
            db.one(
              db.connection.selectNoFrom((eb) =>
                eb
                  .fn<boolean>("app_public.resend_email_verification_code", [sql`${emailId}::uuid`])
                  .as("resend_email_verification_code"),
              ),
            ),
          ).pipe(
            Effect.map((row) => ({
              success: row.resend_email_verification_code === true,
            })),
          ),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
