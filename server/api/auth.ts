import { Effect, Match, Schema as S } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../../shared/httpApi.js";
import { requestObservabilityContext, reportHttpError, datesToUtc, parseCookie } from "./http.js";
import { CurrentSession } from "../../shared/session.js";
import { handleDbError } from "../db.js";
import { ApiError, Conflict, Locked, ServerError, Unauthorized } from "../../shared/errors.js";
import { recordActiveSessions, recordAuthAttempt } from "../metrics.js";
import { AuthService } from "../services/authService.js";
import { Cookies } from "../services/cookies.js";
import {
  OAuthCallbackError,
  OAuthNotConfiguredError,
  OAuthService,
} from "../services/oauthService.js";

export const AuthApiGroupLive = HttpApiBuilder.group(PgGardenApi, "auth", (handlers) =>
  handlers
    .handleAll({
      register: ({ payload }) =>
        AuthService.use((service) => service.register(payload)).pipe(
          Effect.tap(({ token, expiresAt }) =>
            recordAuthAttempt({
              method: "password",
              action: "register",
              result: "success",
            }).pipe(
              Effect.andThen(recordActiveSessions(1)),
              Effect.andThen(Cookies.use((cookies) => cookies.setSession(token, expiresAt))),
            ),
          ),
          Effect.map((result) => ({
            ...datesToUtc(result.user),
            bio: result.user.bio ?? "",
          })),
          Effect.catchTags({
            DuplicateAccount: (e) =>
              recordAuthAttempt({
                method: "password",
                action: "register",
                result: "duplicate",
              }).pipe(Effect.andThen(Effect.fail(new Conflict({ error: e.message })))),
            MissingData: (e) =>
              recordAuthAttempt({
                method: "password",
                action: "register",
                result: "error",
              }).pipe(Effect.andThen(Effect.fail(new ApiError({ error: e.message })))),
            WeakPassword: (e) =>
              recordAuthAttempt({
                method: "password",
                action: "register",
                result: "error",
              }).pipe(Effect.andThen(Effect.fail(new ApiError({ error: e.message })))),
          }),
        ),
      login: ({ payload }) =>
        AuthService.use((service) => service.login(payload)).pipe(
          Effect.tap(({ token, expiresAt }) =>
            recordAuthAttempt({
              method: "password",
              action: "login",
              result: "success",
            }).pipe(
              Effect.andThen(recordActiveSessions(1)),
              Effect.andThen(Cookies.use((cookies) => cookies.setSession(token, expiresAt))),
            ),
          ),
          Effect.map((result) => ({
            ...datesToUtc(result.user),
            bio: result.user.bio ?? "",
          })),
          Effect.catchTags({
            InvalidCredentials: (e) =>
              recordAuthAttempt({
                method: "password",
                action: "login",
                result: "invalid",
              }).pipe(Effect.andThen(Effect.fail(new Unauthorized({ error: e.message })))),
            AccountLocked: (e) =>
              recordAuthAttempt({
                method: "password",
                action: "login",
                result: "locked",
              }).pipe(Effect.andThen(Effect.fail(new Locked({ error: e.message })))),
          }),
        ),
      authMe: () => CurrentSession.pipe(Effect.map(({ user }) => user)),
      logout: () =>
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          yield* AuthService.use((service) => service.logout(session?.cookie_id));
          yield* recordActiveSessions(-1);
          yield* Cookies.use((cookies) => cookies.expireSession);
          return { success: true as const };
        }).pipe(
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
      Effect.gen(function* () {
        const result = yield* OAuthService.use((service) =>
          service.createAuthorizationUrl(["user:email"]),
        );
        const cookies = yield* Cookies;
        return HttpServerResponse.empty({
          status: 302,
          headers: {
            Location: result.url.toString(),
            "Set-Cookie": cookies.shortLivedHeader(STATE_COOKIE, result.state),
          },
        });
      }).pipe(
        // This response renders in the popup, so a failure answers with the page
        // that reports an outcome. JSON here would leave the opener waiting.
        Effect.catch((e) => {
          if (S.is(OAuthNotConfiguredError)(e)) {
            return oauthPopupFailure("GitHub sign-in is not configured on this server.", 503);
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
              ).pipe(Effect.andThen(oauthPopupFailure(error, code))),
            ),
          );
        }),
      ),
    )
    .handleRaw("authGithubCallback", ({ query, request }) =>
      Effect.gen(function* () {
        const storedState = parseCookie(request.headers.cookie, STATE_COOKIE);
        if (!storedState || query.state !== storedState) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: "invalid_state" });
          return yield* oauthPopupFailure("This sign-in could not be verified. Please try again.");
        }

        // GitHub sends `error` instead of `code` when consent is declined.
        if (query.error !== undefined) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: query.error });
          return yield* oauthPopupFailure(
            query.error === "access_denied"
              ? "Sign-in was declined on GitHub."
              : (query.error_description ?? `GitHub refused the sign-in: ${query.error}`),
          );
        }

        const code = query.code;
        if (code === undefined) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: "missing_code" });
          return yield* oauthPopupFailure("GitHub's answer carried no authorization code.");
        }

        const { session: currentSession } = yield* CurrentSession;
        const result = yield* OAuthService.use((service) =>
          service.handleCallback(code, currentSession?.user_id),
        );

        yield* recordAuthAttempt({
          method: "github",
          action: "oauth",
          result: "success",
        });
        if (result.isNewSession) {
          yield* recordActiveSessions(1);
        }

        const html = yield* buildOAuthPopupHtml({ type: "github-auth-success" });
        const cookies = yield* Cookies;

        return HttpServerResponse.text(html, {
          status: 200,
          contentType: "text/html",
          // The session cookie is what the opener reads its identity from, so
          // the page and the cookie arrive in the same response.
          headers: { "Set-Cookie": result.setCookie ?? cookies.expiredHeader(STATE_COOKIE) },
        });
      }).pipe(
        Effect.catch((e) => {
          if (S.is(OAuthCallbackError)(e)) {
            return recordAuthAttempt({
              method: "github",
              action: "oauth",
              result: e.isBadCode ? "bad_verification_code" : "error",
            }).pipe(
              Effect.andThen(
                oauthPopupFailure(
                  e.isBadCode ? "GitHub rejected this sign-in attempt." : e.message,
                ),
              ),
            );
          }
          if (S.is(OAuthNotConfiguredError)(e)) {
            return oauthPopupFailure("GitHub sign-in is not configured on this server.", 503);
          }
          return recordAuthAttempt({
            method: "github",
            action: "oauth",
            result: "error",
          }).pipe(
            Effect.andThen(handleDbError(e, "OAuth error")),
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
              ).pipe(Effect.andThen(oauthPopupFailure(error, code))),
            ),
          );
        }),
      ),
    ),
);

/**
 * The outcome the popup reports to the tab that opened it. It names no user:
 * the callback's response carries the session cookie, so the opener asks the
 * server who it now is rather than trusting a message from another window.
 */
const OAuthPopupOutcome = S.Union([
  S.Struct({ type: S.Literals(["github-auth-success"]) }),
  S.Struct({ type: S.Literals(["github-auth-failure"]), message: S.String }),
]);
type OAuthPopupOutcome = typeof OAuthPopupOutcome.Type;

/** `&`, `<` and the quotes, so a value cannot leave the attribute or text it sits in. */
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

/**
 * The page the OAuth popup ends on, whichever way the flow went.
 *
 * The outcome travels in an attribute rather than inside the script, so no
 * message text can close the `<script>` element and run as code.
 */
const buildOAuthPopupHtml = Effect.fnUntraced(function* (outcome: OAuthPopupOutcome) {
  const view = Match.value(outcome).pipe(
    Match.discriminatorsExhaustive("type")({
      "github-auth-success": () => ({
        icon: "✓",
        title: "Authentication Successful!",
        body: 'Returning to the application<span class="spinner"></span>',
      }),
      "github-auth-failure": ({ message }) => ({
        icon: "✕",
        title: "Authentication Failed",
        body: escapeHtml(message),
      }),
    }),
  );
  // The value was just built from the union being encoded, so a failure here
  // would mean the schema and its own type disagree.
  const encoded = yield* S.encodeEffect(S.fromJsonString(OAuthPopupOutcome))(outcome).pipe(
    Effect.orDie,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${view.title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0; background: #1e1e1e; color: #cccccc;
    }
    .container { text-align: center; padding: 2rem; }
    .success-icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem 0; color: #ffffff; }
    p { margin: 0; color: #cccccc; }
    .spinner {
      display: inline-block; width: 20px; height: 20px;
      border: 3px solid rgba(255,255,255,0.3); border-radius: 50%;
      border-top-color: #007acc; animation: spin 1s ease-in-out infinite; margin-left: 0.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container" id="outcome" data-outcome="${escapeHtml(encoded)}">
    <div class="success-icon">${view.icon}</div>
    <h1>${view.title}</h1>
    <p>${view.body}</p>
  </div>
  <script>
    (function () {
      try {
        var channel = new BroadcastChannel("github-auth");
        channel.postMessage(JSON.parse(document.getElementById("outcome").dataset.outcome));
        channel.close();
        setTimeout(function () { window.close(); }, 500);
      } catch (error) {
        console.error("Failed to report the authentication outcome:", error);
        document.querySelector("p").textContent =
          "This window could not reach the application. Please close it and try again.";
      }
    })();
  </script>
</body>
</html>`;
});

const STATE_COOKIE = "github_oauth_state";

/**
 * A failed sign-in as the popup page, so the tab that opened it hears an
 * outcome instead of waiting out its timeout. However the attempt ended, the
 * flow is over, so the state cookie goes with it.
 */
const oauthPopupFailure = (message: string, status = 400) =>
  Effect.all([buildOAuthPopupHtml({ type: "github-auth-failure", message }), Cookies]).pipe(
    Effect.map(([html, cookies]) =>
      HttpServerResponse.text(html, {
        status,
        contentType: "text/html",
        headers: { "Set-Cookie": cookies.expiredHeader(STATE_COOKIE) },
      }),
    ),
  );
