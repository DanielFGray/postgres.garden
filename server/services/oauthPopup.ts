import { Context, Effect, Layer, Match, Option, Schema as S } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { GithubCallbackQuery } from "../../shared/api/auth.js";
import { CurrentSession } from "../../shared/session.js";
import { recordActiveSessions, recordAuthAttempt } from "../metrics.js";
import { Cookies } from "./cookies.js";
import { OAuthCallbackError, OAuthNotConfiguredError, OAuthService } from "./oauthService.js";

/**
 * GitHub sign-in in a popup window. `start` sends the popup to GitHub with a
 * state cookie; `finish` checks GitHub's answer against that cookie, signs the
 * caller in, and ends on a page that tells the opener the outcome. Every
 * answer the popup sees is that page, never JSON, so the opener always hears
 * an outcome instead of waiting out its timeout.
 *
 * @effect-expect-leaking HttpServerRequest
 */
export class OAuthPopup extends Context.Service<OAuthPopup>()("OAuthPopup", {
  make: Effect.gen(function* () {
    const oauth = yield* OAuthService;
    const cookies = yield* Cookies;

    /**
     * A failed sign-in as the popup page. However the attempt ended, the flow
     * is over, so the state cookie goes with it.
     */
    const failure = (message: string, status = 400) =>
      buildOAuthPopupHtml({ type: "github-auth-failure", message }).pipe(
        Effect.map((html) =>
          HttpServerResponse.text(html, {
            status,
            contentType: "text/html",
            headers: { "Set-Cookie": cookies.expiredHeader(STATE_COOKIE) },
          }),
        ),
      );

    const start = oauth.createAuthorizationUrl(["user:email"]).pipe(
      Effect.map(({ url, state }) =>
        HttpServerResponse.empty({
          status: 302,
          headers: {
            Location: url.toString(),
            "Set-Cookie": cookies.shortLivedHeader(STATE_COOKIE, state),
          },
        }),
      ),
    );

    const finish = Effect.fnUntraced(
      function* (query: typeof GithubCallbackQuery.Type) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const storedState = Option.fromNullishOr(request.cookies[STATE_COOKIE]);
        if (Option.isNone(storedState) || query.state !== storedState.value) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: "invalid_state" });
          return yield* failure("This sign-in could not be verified. Please try again.");
        }

        // GitHub sends `error` instead of `code` when consent is declined.
        if (query.error !== undefined) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: query.error });
          return yield* failure(
            query.error === "access_denied"
              ? "Sign-in was declined on GitHub."
              : (query.error_description ?? `GitHub refused the sign-in: ${query.error}`),
          );
        }

        const code = query.code;
        if (code === undefined) {
          yield* recordAuthAttempt({ method: "github", action: "oauth", result: "missing_code" });
          return yield* failure("GitHub's answer carried no authorization code.");
        }

        const { session: currentSession } = yield* CurrentSession;
        const result = yield* oauth.handleCallback(code, currentSession?.user_id);

        yield* recordAuthAttempt({ method: "github", action: "oauth", result: "success" });
        if (result.isNewSession) {
          yield* recordActiveSessions(1);
        }

        const html = yield* buildOAuthPopupHtml({ type: "github-auth-success" });
        return HttpServerResponse.text(html, {
          status: 200,
          contentType: "text/html",
          // The session cookie is what the opener reads its identity from, so
          // the page and the cookie arrive in the same response.
          headers: { "Set-Cookie": result.setCookie ?? cookies.expiredHeader(STATE_COOKIE) },
        });
      },
      // A server that is not set up for GitHub sign-in saw no attempt to count.
      Effect.tapError((e) =>
        S.is(OAuthNotConfiguredError)(e)
          ? Effect.void
          : recordAuthAttempt({
              method: "github",
              action: "oauth",
              result:
                S.is(OAuthCallbackError)(e) && e.isBadCode ? "bad_verification_code" : "error",
            }),
      ),
    );

    return { start, finish, failure } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(OAuthService.layer, Cookies.layer)),
  );
}

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
