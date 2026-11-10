import { Effect, Schema as S } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { requestObservabilityContext, reportHttpError, datesToUtc } from "./http.js";
import { CurrentSession } from "../../shared/session.js";
import { handleDbError } from "../db.js";
import { ApiError, Conflict, Locked, ServerError, Unauthorized } from "../../shared/errors.js";
import { AuthService } from "../services/authService.js";
import { OAuthPopup } from "../services/oauthPopup.js";
import { OAuthCallbackError, OAuthNotConfiguredError } from "../services/oauthService.js";

export const AuthApiGroupLive = HttpApiBuilder.group(PgGardenApi, "auth", (handlers) =>
  handlers
    .handleAll({
      register: ({ payload }) =>
        AuthService.use((service) => service.register(payload)).pipe(
          Effect.map((user) => ({ ...datesToUtc(user), bio: user.bio ?? "" })),
          Effect.catchTags({
            DuplicateAccount: (e) => Effect.fail(new Conflict({ error: e.message })),
            MissingData: (e) => Effect.fail(new ApiError({ error: e.message })),
            WeakPassword: (e) => Effect.fail(new ApiError({ error: e.message })),
          }),
        ),
      login: ({ payload }) =>
        AuthService.use((service) => service.login(payload)).pipe(
          Effect.map((user) => ({ ...datesToUtc(user), bio: user.bio ?? "" })),
          Effect.catchTags({
            InvalidCredentials: (e) => Effect.fail(new Unauthorized({ error: e.message })),
            AccountLocked: (e) => Effect.fail(new Locked({ error: e.message })),
          }),
        ),
      authMe: () => CurrentSession.pipe(Effect.map(({ user }) => user)),
      logout: () =>
        AuthService.use((service) => service.logout).pipe(
          Effect.catch((e) =>
            handleDbError(e, "Logout failed").pipe(
              Effect.flatMap(({ code, error }) => {
                const httpError: ApiError | ServerError =
                  code >= 500 ? new ServerError({ error }) : new ApiError({ error });
                return reportHttpError({
                  route: "logout",
                  status: code,
                  kind: "unknown",
                  error: e,
                }).pipe(Effect.andThen(Effect.fail(httpError)));
              }),
            ),
          ),
        ),
    })
    .handleRaw("authGithubStart", ({ request }) =>
      OAuthPopup.use((popup) => popup.start).pipe(
        // This response renders in the popup, so a failure answers with the page
        // that reports an outcome. JSON here would leave the opener waiting.
        Effect.catch((e) => {
          if (S.is(OAuthNotConfiguredError)(e)) {
            return OAuthPopup.use((popup) =>
              popup.failure("GitHub sign-in is not configured on this server.", 503),
            );
          }
          return handleDbError(e, "OAuth error").pipe(
            Effect.flatMap(({ code, error }) =>
              (code >= 400
                ? reportHttpError({
                    route: "authGithubStart",
                    status: code,
                    kind: "oauth",
                    error: e,
                    context: requestObservabilityContext(request.headers),
                  })
                : Effect.void
              ).pipe(Effect.andThen(OAuthPopup.use((popup) => popup.failure(error, code)))),
            ),
          );
        }),
      ),
    )
    .handleRaw("authGithubCallback", ({ query, request }) =>
      OAuthPopup.use((popup) => popup.finish(query)).pipe(
        Effect.catch((e) => {
          if (S.is(OAuthCallbackError)(e)) {
            return OAuthPopup.use((popup) =>
              popup.failure(e.isBadCode ? "GitHub rejected this sign-in attempt." : e.message),
            );
          }
          if (S.is(OAuthNotConfiguredError)(e)) {
            return OAuthPopup.use((popup) =>
              popup.failure("GitHub sign-in is not configured on this server.", 503),
            );
          }
          return handleDbError(e, "OAuth error").pipe(
            Effect.flatMap(({ code, error }) =>
              (code >= 400
                ? reportHttpError({
                    route: "authGithubCallback",
                    status: code,
                    kind: "oauth",
                    error: e,
                    context: requestObservabilityContext(request.headers),
                  })
                : Effect.void
              ).pipe(Effect.andThen(OAuthPopup.use((popup) => popup.failure(error, code)))),
            ),
          );
        }),
      ),
    ),
);
