import { Context, Effect, Layer, Option, Schema as S } from "effect";
import { type Selectable, sql } from "kysely";
import { PgRootDB, queriesOn, type DB } from "../db.js";
import { requestDb } from "../requestDatabase.js";
import type { AppPublicUserEmails as UserEmail } from "../../generated/db.js";
import { UserEmailRow, UserRow } from "../rows.js";

export interface UpdateProfileInput {
  readonly username?: string;
  readonly name?: string | null;
  readonly bio?: string;
  readonly avatar_url?: string | null;
}

/**
 * The columns of `app_public.user_authentications` that leave the server: the
 * row's `details` hold the provider's profile.
 */
const AuthenticationRow = S.Struct({
  id: S.String,
  service: S.String,
  identifier: S.String,
  created_at: S.Date,
});

/** What a SQL function that answers true or false returns; null when it did nothing. */
const Flag = S.NullOr(S.Boolean);

export class Users extends Context.Service<Users>()("postgres-garden/users", {
  make: Effect.gen(function* () {
    const root = queriesOn<DB>(yield* PgRootDB);
    return {
      requestAccountDeletion: Effect.fn("Users.requestAccountDeletion")(function* (
        token: string | undefined,
      ) {
        if (!token) {
          const row = yield* requestDb.one(S.Struct({ request_account_deletion: Flag }), (k) =>
            k.selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.request_account_deletion", [])
                .as("request_account_deletion"),
            ),
          );
          return row.request_account_deletion === true;
        }

        const row = yield* requestDb.one(S.Struct({ confirm_account_deletion: Flag }), (k) =>
          k.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.confirm_account_deletion", [eb.val(token)])
              .as("confirm_account_deletion"),
          ),
        );
        return row.confirm_account_deletion === true;
      }),

      getProfile: Effect.fn("Users.getProfile")(() =>
        requestDb
          .maybe(UserRow, (k) =>
            k
              .selectFrom("app_public.users")
              .selectAll()
              .where("id", "=", sql<string>`app_public.current_user_id()`),
          )
          .pipe(Effect.map(Option.getOrNull)),
      ),

      updateProfile: Effect.fn("Users.updateProfile")((input: UpdateProfileInput) =>
        requestDb
          .all(UserRow, (k) =>
            k
              .updateTable("app_public.users")
              .where("id", "=", sql<string>`app_public.current_user_id()`)
              .$if(input.username !== undefined, (q) => q.set("username", input.username!))
              .$if(input.name !== undefined, (q) => q.set("name", input.name!))
              .$if(input.bio !== undefined, (q) => q.set("bio", input.bio!))
              .$if(input.avatar_url !== undefined, (q) => q.set("avatar_url", input.avatar_url!))
              .returningAll(),
          )
          .pipe(Effect.head),
      ),

      listEmails: Effect.fn("Users.listEmails")(() =>
        requestDb.all(UserEmailRow, (k) =>
          k
            .selectFrom("app_public.user_emails")
            .selectAll()
            .where("user_id", "=", sql<string>`app_public.current_user_id()`)
            .orderBy("is_primary", "desc")
            .orderBy("created_at", "asc"),
        ),
      ),

      addEmail: Effect.fn("Users.addEmail")((email: string) =>
        requestDb.one(UserEmailRow, (k) =>
          k.insertInto("app_public.user_emails").values({ email }).returningAll(),
        ),
      ),

      deleteEmail: Effect.fn("Users.deleteEmail")((id: string) =>
        requestDb
          .all(UserEmailRow, (k) =>
            k.deleteFrom("app_public.user_emails").where("id", "=", id).returningAll(),
          )
          .pipe(Effect.head),
      ),

      listAuthentications: Effect.fn("Users.listAuthentications")(() =>
        requestDb.all(AuthenticationRow, (k) =>
          k
            .selectFrom("app_public.user_authentications")
            .select(["id", "service", "identifier", "created_at"])
            .where("user_id", "=", sql<string>`app_public.current_user_id()`)
            .orderBy("created_at", "asc"),
        ),
      ),

      unlinkAuthentication: Effect.fn("Users.unlinkAuthentication")((id: string) =>
        requestDb
          .all(S.Struct({ id: S.String }), (k) =>
            k.deleteFrom("app_public.user_authentications").where("id", "=", id).returning("id"),
          )
          .pipe(Effect.head),
      ),

      hasPassword: Effect.fn("Users.hasPassword")(() =>
        requestDb
          .all(S.Struct({ has_password: S.Boolean }), (k) =>
            k
              .selectFrom("app_public.users as u")
              .select((eb) => [
                eb.fn<boolean>("app_public.users_has_password", [sql`u.*`]).as("has_password"),
              ])
              .where("u.id", "=", sql<string>`app_public.current_user_id()`),
          )
          .pipe(Effect.head),
      ),

      forgotPassword: Effect.fn("Users.forgotPassword")((email: string) =>
        root.exec((k) =>
          k.selectNoFrom((eb) =>
            eb
              .fn<void>("app_public.forgot_password", [sql`${email}::citext`])
              .as("forgot_password"),
          ),
        ),
      ),

      resetPassword: Effect.fn("Users.resetPassword")(function* (token: string, password: string) {
        const row = yield* root.one(S.Struct({ reset_password: Flag }), (k) =>
          k.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_private.reset_password", [eb.val(token), eb.val(password)])
              .as("reset_password"),
          ),
        );
        return { success: row.reset_password === true };
      }),

      changePassword: Effect.fn("Users.changePassword")(function* (
        oldPassword: string,
        newPassword: string,
      ) {
        const row = yield* requestDb.one(S.Struct({ change_password: Flag }), (k) =>
          k.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.change_password", [eb.val(oldPassword), eb.val(newPassword)])
              .as("change_password"),
          ),
        );
        return { success: row.change_password === true };
      }),

      verifyEmail: Effect.fn("Users.verifyEmail")(function* (token: string) {
        const row = yield* root.one(S.Struct({ verify_email: Flag }), (k) =>
          k.selectNoFrom((eb) =>
            eb.fn<boolean>("app_public.verify_email", [eb.val(token)]).as("verify_email"),
          ),
        );
        return { success: row.verify_email === true };
      }),

      makeEmailPrimary: Effect.fn("Users.makeEmailPrimary")((emailId: string) =>
        requestDb.one(UserEmailRow, (k) =>
          k
            .selectFrom((eb) =>
              eb
                .fn<Selectable<UserEmail>>("app_public.make_email_primary", [sql`${emailId}::uuid`])
                .as("make_email_primary"),
            )
            .selectAll(),
        ),
      ),

      resendEmailVerificationCode: Effect.fn("Users.resendEmailVerificationCode")(function* (
        emailId: string,
      ) {
        const row = yield* requestDb.one(S.Struct({ resend_email_verification_code: Flag }), (k) =>
          k.selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.resend_email_verification_code", [sql`${emailId}::uuid`])
              .as("resend_email_verification_code"),
          ),
        );
        return { success: row.resend_email_verification_code === true };
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(PgRootDB.layer));
}
