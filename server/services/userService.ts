import { Context, Effect, Layer } from "effect";
import { type Selectable, sql } from "kysely";
import { asRoot, asVisitor } from "../db.js";
import type { AppPublicUserEmails as UserEmail } from "../../generated/db.js";

export interface UpdateProfileInput {
  readonly username?: string;
  readonly name?: string | null;
  readonly bio?: string;
  readonly avatar_url?: string | null;
}

export class UserService extends Context.Service<UserService>()("UserService", {
  make: Effect.sync(() => {
    return {
      requestAccountDeletion: Effect.fnUntraced(function* (token: string | undefined) {
        if (!token) {
          return yield* asVisitor((authDb) =>
            authDb.selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.request_account_deletion", [])
                .as("request_account_deletion"),
            ),
          ).pipe(
            Effect.head,
            Effect.map((rows) => rows?.request_account_deletion === true),
          );
        }

        return yield* asVisitor((authDb) =>
          authDb.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.confirm_account_deletion", [eb.val(token)])
              .as("confirm_account_deletion"),
          ),
        ).pipe(
          Effect.head,
          Effect.map((rows) => rows?.confirm_account_deletion === true),
        );
      }),

      getProfile: asVisitor((authDb) =>
        authDb
          .selectFrom("app_public.users")
          .selectAll()
          .where("id", "=", sql<string>`app_public.current_user_id()`),
      ).pipe(
        Effect.head,
        Effect.catchTag("NoSuchElementError", () => Effect.succeed(null)),
      ),

      updateProfile: (input: UpdateProfileInput) =>
        asVisitor((authDb) =>
          authDb
            .updateTable("app_public.users")
            .where("id", "=", sql<string>`app_public.current_user_id()`)
            .$if(input.username !== undefined, (q) => q.set("username", input.username!))
            .$if(input.name !== undefined, (q) => q.set("name", input.name!))
            .$if(input.bio !== undefined, (q) => q.set("bio", input.bio!))
            .$if(input.avatar_url !== undefined, (q) => q.set("avatar_url", input.avatar_url!))
            .returningAll(),
        ).pipe(Effect.head),

      listEmails: asVisitor((authDb) =>
        authDb
          .selectFrom("app_public.user_emails")
          .selectAll()
          .where("user_id", "=", sql<string>`app_public.current_user_id()`)
          .orderBy("is_primary", "desc")
          .orderBy("created_at", "asc"),
      ),

      addEmail: (email: string) =>
        asVisitor((authDb) =>
          authDb.insertInto("app_public.user_emails").values({ email }).returningAll(),
        ).pipe(Effect.head),

      deleteEmail: (id: string) =>
        asVisitor((authDb) =>
          authDb.deleteFrom("app_public.user_emails").where("id", "=", id).returningAll(),
        ).pipe(Effect.head),

      listAuthentications: asVisitor((authDb) =>
        authDb
          .selectFrom("app_public.user_authentications")
          .select(["id", "service", "identifier", "created_at"])
          .where("user_id", "=", sql<string>`app_public.current_user_id()`)
          .orderBy("created_at", "asc"),
      ),

      unlinkAuthentication: (id: string) =>
        asVisitor((authDb) =>
          authDb.deleteFrom("app_public.user_authentications").where("id", "=", id).returningAll(),
        ).pipe(Effect.head),

      hasPassword: asVisitor((authDb) =>
        authDb
          .selectFrom("app_public.users as u")
          .select((eb) => [
            eb.fn<boolean>("app_public.users_has_password", [sql`u.*`]).as("has_password"),
          ])
          .where("u.id", "=", sql<string>`app_public.current_user_id()`),
      ).pipe(Effect.head),

      forgotPassword: (email: string) =>
        asRoot((rootDb) =>
          rootDb.selectNoFrom((eb) =>
            eb
              .fn<void>("app_public.forgot_password", [sql`${email}::citext`])
              .as("forgot_password"),
          ),
        ).pipe(Effect.asVoid),

      resetPassword: (userId: string, token: string, password: string) =>
        asRoot((rootDb) =>
          rootDb.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_private.reset_password", [
                sql`${userId}::uuid`,
                eb.val(token),
                eb.val(password),
              ])
              .as("reset_password"),
          ),
        ).pipe(
          Effect.head,
          Effect.map((rows) => ({ success: rows?.reset_password === true })),
        ),

      changePassword: (oldPassword: string, newPassword: string) =>
        asVisitor((authDb) =>
          authDb.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.change_password", [eb.val(oldPassword), eb.val(newPassword)])
              .as("change_password"),
          ),
        ).pipe(
          Effect.head,
          Effect.map((rows) => ({ success: rows?.change_password === true })),
        ),

      verifyEmail: (emailId: string, token: string) =>
        asRoot((rootDb) =>
          rootDb.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.verify_email", [sql`${emailId}::uuid`, eb.val(token)])
              .as("verify_email"),
          ),
        ).pipe(
          Effect.head,
          Effect.map((rows) => ({ success: rows?.verify_email === true })),
        ),

      makeEmailPrimary: (emailId: string) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom((eb) =>
              eb
                .fn<Selectable<UserEmail>>("app_public.make_email_primary", [sql`${emailId}::uuid`])
                .as("make_email_primary"),
            )
            .selectAll(),
        ).pipe(
          Effect.head,
          Effect.catchTag("NoSuchElementError", () =>
            Effect.die(new Error("Failed to make email primary")),
          ),
        ),

      resendEmailVerificationCode: (emailId: string) =>
        asVisitor((authDb) =>
          authDb.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.resend_email_verification_code", [sql`${emailId}::uuid`])
              .as("resend_email_verification_code"),
          ),
        ).pipe(
          Effect.head,
          Effect.map((row) => ({
            success: row?.resend_email_verification_code === true,
          })),
        ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
