import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { withDbError, withDbErrorOrMissing, requireSession } from "./http.js";
import { CurrentSession } from "../../shared/session.js";
import { UserService } from "../services/userService.js";

export const UsersApiGroupLive = HttpApiBuilder.group(PgGardenApi, "apiUsers", (handlers) =>
  handlers.handleAll({
    me: ({ request }) =>
      Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        if (!session) return { user: null };
        const profile = yield* withDbError(
          "Failed to fetch profile",
          UserService.use((service) => service.getProfile),
          request.headers,
        );
        return { user: profile };
      }),
    deleteMe: ({ query, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMe", request.headers);
        const success = yield* withDbError(
          "Account deletion failed",
          UserService.use((service) => service.requestAccountDeletion(query.token)),
          request.headers,
        );
        return { success };
      }),
    patchMe: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.patchMe", request.headers);
        return yield* withDbErrorOrMissing(
          "Failed to update profile",
          UserService.use((service) => service.updateProfile(payload)),
          "User not found",
          request.headers,
        );
      }),
    meEmails: ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meEmails", request.headers);
        return yield* withDbError(
          "Failed to fetch emails",
          UserService.use((service) => service.listEmails),
          request.headers,
        );
      }),
    createMeEmail: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.createMeEmail", request.headers);
        return yield* withDbError(
          "Failed to add email",
          UserService.use((service) => service.addEmail(payload.email)),
          request.headers,
        );
      }),
    deleteMeEmail: ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMeEmail", request.headers);
        return yield* withDbErrorOrMissing(
          "Failed to delete email",
          UserService.use((service) => service.deleteEmail(params.id)),
          "Email not found",
          request.headers,
        );
      }),
    meAuthentications: ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meAuthentications", request.headers);
        return yield* withDbError(
          "Failed to fetch authentications",
          UserService.use((service) => service.listAuthentications),
          request.headers,
        );
      }),
    deleteMeAuthentication: ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMeAuthentication", request.headers);
        return yield* withDbErrorOrMissing(
          "Failed to delete authentication",
          UserService.use((service) => service.unlinkAuthentication(params.id)).pipe(
            Effect.map((result) => ({ id: result.id })),
          ),
          "Authentication not found",
          request.headers,
        );
      }),
    meHasPassword: ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meHasPassword", request.headers);
        return yield* withDbErrorOrMissing(
          "Failed to check password",
          UserService.use((service) => service.hasPassword).pipe(
            Effect.map((result) => ({ has_password: result.has_password })),
          ),
          "User not found",
          request.headers,
        );
      }),
    forgotPassword: ({ payload, request }) =>
      withDbError(
        "Failed to send password reset",
        UserService.use((service) => service.forgotPassword(payload.email)).pipe(
          Effect.as({ success: true as const }),
        ),
        request.headers,
      ),
    resetPassword: ({ payload, request }) =>
      withDbError(
        "Failed to reset password",
        UserService.use((service) =>
          service.resetPassword(payload.userId, payload.token, payload.password),
        ),
        request.headers,
      ),
    changePassword: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.changePassword", request.headers);
        return yield* withDbError(
          "Failed to change password",
          UserService.use((service) =>
            service.changePassword(payload.oldPassword, payload.newPassword),
          ),
          request.headers,
        );
      }),
    verifyEmail: ({ payload, request }) =>
      withDbError(
        "Failed to verify email",
        UserService.use((service) => service.verifyEmail(payload.emailId, payload.token)),
        request.headers,
      ),
    makeEmailPrimary: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.makeEmailPrimary", request.headers);
        return yield* withDbError(
          "Failed to update primary email",
          UserService.use((service) => service.makeEmailPrimary(payload.emailId)),
          request.headers,
        );
      }),
    resendEmailVerificationCode: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.resendEmailVerificationCode", request.headers);
        return yield* withDbError(
          "Failed to resend verification",
          UserService.use((service) => service.resendEmailVerificationCode(payload.emailId)),
          request.headers,
        );
      }),
  }),
);
