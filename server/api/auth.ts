import { Cause, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { Unauthorized } from "../../shared/errors.js";
import { toHttpError } from "../databaseErrors.js";
import { reportUnexpected } from "../failureBoundary.js";
import { AuthService } from "../services/authService.js";
import { OAuthPopup } from "../services/oauthPopup.js";

const notConfigured = "GitHub sign-in is not configured on this server.";

export const AuthApiGroupLive = HttpApiBuilder.group(PgGardenApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService;
    const popup = yield* OAuthPopup;

    /**
     * The popup routes render a page that reports the outcome to the opener, so
     * they answer their own failures: JSON would leave the opener waiting. A
     * refused query shows the refusal's message; a defect is logged once, as
     * the failure boundary does, and the page shows its trace id.
     */
    const answerDefect = <E>(cause: Cause.Cause<E>) =>
      reportUnexpected(cause).pipe(
        Effect.catchTag("InternalError", (internal) =>
          popup.failure(`${internal.message} Reference: ${internal.traceId}`, 500),
        ),
      );

    return handlers
      .handleAll({
        register: ({ payload }) =>
          auth.register(payload).pipe(
            Effect.map((user) => ({ ...user, bio: user.bio ?? "" })),
            Effect.catchTag("DatabaseError", toHttpError),
          ),
        login: ({ payload }) =>
          auth.login(payload).pipe(
            Effect.map((user) => ({ ...user, bio: user.bio ?? "" })),
            Effect.catchTags({
              InvalidCredentials: (e) =>
                Effect.fail(
                  new Unauthorized({ message: e.message, reason: "invalid_credentials" }),
                ),
              DatabaseError: toHttpError,
            }),
          ),
        logout: () => auth.logout().pipe(Effect.catchTag("DatabaseError", toHttpError)),
      })
      .handleRaw("authGithubStart", () =>
        popup.start().pipe(
          Effect.catchTag("OAuthNotConfigured", () => popup.failure(notConfigured, 503)),
          Effect.catchCauseIf(Cause.hasDies, answerDefect),
        ),
      )
      .handleRaw("authGithubCallback", ({ query }) =>
        popup.finish(query).pipe(
          Effect.catchTags({
            OAuthCallbackError: (e) =>
              Effect.logWarning("GitHub sign-in failed", Cause.fail(e)).pipe(
                Effect.andThen(
                  popup.failure(e.isBadCode ? "GitHub rejected this sign-in attempt." : e.message),
                ),
              ),
            OAuthNotConfigured: () => popup.failure(notConfigured, 503),
            DatabaseError: (e) =>
              toHttpError(e).pipe(Effect.catch((refusal) => popup.failure(refusal.message))),
          }),
          Effect.catchCauseIf(Cause.hasDies, answerDefect),
        ),
      );
  }),
);
