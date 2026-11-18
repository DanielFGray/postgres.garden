import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { NotFound } from "@danielfgray/stompbox/http";
import { requireSession } from "./http.js";
import { withAuthContext } from "../requestDatabase.js";
import { CurrentSession } from "../../shared/session.js";
import { Users } from "../services/users.js";

export const UsersApiGroupLive = HttpApiBuilder.group(PgGardenApi, "users", (handlers) =>
  Effect.gen(function* () {
    const users = yield* Users;
    return handlers.handleAll({
      me: () =>
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          if (!session) return { user: null };
          const profile = yield* users.getProfile().pipe(withAuthContext);
          return { user: profile };
        }),
      deleteMe: ({ query }) =>
        Effect.gen(function* () {
          yield* requireSession;
          const success = yield* users.requestAccountDeletion(query.token).pipe(withAuthContext);
          return { success };
        }),
      patchMe: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.updateProfile(payload).pipe(
            withAuthContext,
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ message: "User not found" })),
            ),
          );
        }),
      meEmails: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.listEmails().pipe(withAuthContext);
        }),
      createMeEmail: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.addEmail(payload.email).pipe(withAuthContext);
        }),
      deleteMeEmail: ({ params }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.deleteEmail(params.id).pipe(
            withAuthContext,
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ message: "Email not found" })),
            ),
          );
        }),
      meAuthentications: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.listAuthentications().pipe(withAuthContext);
        }),
      deleteMeAuthentication: ({ params }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.unlinkAuthentication(params.id).pipe(
            Effect.map((result) => ({ id: result.id })),
            withAuthContext,
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ message: "Authentication not found" })),
            ),
          );
        }),
      meHasPassword: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.hasPassword().pipe(
            Effect.map((result) => ({ has_password: result.has_password })),
            withAuthContext,
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ message: "User not found" })),
            ),
          );
        }),
      forgotPassword: ({ payload }) =>
        users.forgotPassword(payload.email).pipe(Effect.as({ success: true as const })),
      resetPassword: ({ payload }) => users.resetPassword(payload.token, payload.password),
      changePassword: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .changePassword(payload.oldPassword, payload.newPassword)
            .pipe(withAuthContext);
        }),
      verifyEmail: ({ payload }) => users.verifyEmail(payload.token),
      makeEmailPrimary: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.makeEmailPrimary(payload.emailId).pipe(withAuthContext);
        }),
      resendEmailVerificationCode: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.resendEmailVerificationCode(payload.emailId).pipe(withAuthContext);
        }),
    });
  }),
);
