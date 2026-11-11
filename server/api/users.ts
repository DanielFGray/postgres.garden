import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { NotFound } from "../../shared/errors.js";
import { toHttpError } from "../databaseErrors.js";
import { requireSession } from "./http.js";
import { withAuthContext } from "../requestDatabase.js";
import { CurrentSession } from "../../shared/session.js";
import { UserService } from "../services/userService.js";

export const UsersApiGroupLive = HttpApiBuilder.group(PgGardenApi, "apiUsers", (handlers) =>
  Effect.gen(function* () {
    const users = yield* UserService;
    return handlers.handleAll({
      me: () =>
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          if (!session) return { user: null };
          const profile = yield* users
            .getProfile()
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
          return { user: profile };
        }),
      deleteMe: ({ query }) =>
        Effect.gen(function* () {
          yield* requireSession;
          const success = yield* users
            .requestAccountDeletion(query.token)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
          return { success };
        }),
      patchMe: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.updateProfile(payload).pipe(
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () => Effect.fail(new NotFound({ message: "User not found" })),
              DatabaseError: toHttpError,
            }),
          );
        }),
      meEmails: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .listEmails()
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
      createMeEmail: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .addEmail(payload.email)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
      deleteMeEmail: ({ params }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.deleteEmail(params.id).pipe(
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () => Effect.fail(new NotFound({ message: "Email not found" })),
              DatabaseError: toHttpError,
            }),
          );
        }),
      meAuthentications: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .listAuthentications()
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
      deleteMeAuthentication: ({ params }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.unlinkAuthentication(params.id).pipe(
            Effect.map((result) => ({ id: result.id })),
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () =>
                Effect.fail(new NotFound({ message: "Authentication not found" })),
              DatabaseError: toHttpError,
            }),
          );
        }),
      meHasPassword: () =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users.hasPassword().pipe(
            Effect.map((result) => ({ has_password: result.has_password })),
            withAuthContext,
            Effect.catchTags({
              NoSuchElementError: () => Effect.fail(new NotFound({ message: "User not found" })),
              DatabaseError: toHttpError,
            }),
          );
        }),
      forgotPassword: ({ payload }) =>
        users
          .forgotPassword(payload.email)
          .pipe(
            Effect.as({ success: true as const }),
            Effect.catchTag("DatabaseError", toHttpError),
          ),
      resetPassword: ({ payload }) =>
        users
          .resetPassword(payload.userId, payload.token, payload.password)
          .pipe(Effect.catchTag("DatabaseError", toHttpError)),
      changePassword: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .changePassword(payload.oldPassword, payload.newPassword)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
      verifyEmail: ({ payload }) =>
        users
          .verifyEmail(payload.emailId, payload.token)
          .pipe(Effect.catchTag("DatabaseError", toHttpError)),
      makeEmailPrimary: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .makeEmailPrimary(payload.emailId)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
      resendEmailVerificationCode: ({ payload }) =>
        Effect.gen(function* () {
          yield* requireSession;
          return yield* users
            .resendEmailVerificationCode(payload.emailId)
            .pipe(withAuthContext, Effect.catchTag("DatabaseError", toHttpError));
        }),
    });
  }),
);
