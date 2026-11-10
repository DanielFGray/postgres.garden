import { Cause, Config, DateTime, Effect, Layer, Match, Schema as S } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Redis } from "effect/persistence/Redis";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentSession, EDIT_KEY_HEADER, PgGardenApi } from "./apiSchema.js";
import { DatabaseLive, handleDbError } from "./db.js";
import { ApiError, Conflict, Locked, NotFound, ServerError, Unauthorized } from "./errors.js";
import {
  recordActiveSessions,
  recordAuthAttempt,
  recordHttpError,
  recordWebhook,
} from "./metrics.js";
import { checkDependencies } from "./ready.js";
import { AuthService } from "./services/authService.js";
import { Cookies } from "./services/cookies.js";
import {
  OAuthCallbackError,
  OAuthNotConfiguredError,
  OAuthService,
} from "./services/oauthService.js";
import { PlaygroundService } from "./services/playgroundService.js";
import { SessionMiddlewareLive } from "./services/sessionMiddleware.js";
import { SessionService } from "./services/sessionService.js";
import { UserService } from "./services/userService.js";
import {
  WebhookNotConfiguredError,
  WebhookService,
  WebhookVerificationError,
} from "./services/webhookService.js";

// ---------------------------------------------------------------------------
// Request observability
// ---------------------------------------------------------------------------

type RequestHeaders = Record<string, string | ReadonlyArray<string> | undefined>;

type RequestObservabilityContext = {
  readonly requestId?: string;
  readonly uiAction?: string;
  readonly uiFeature?: string;
  readonly traceparent?: string;
};

const readHeader = (headers: RequestHeaders, name: string): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
};

const requestObservabilityContext = (
  headers: RequestHeaders | undefined,
): RequestObservabilityContext | undefined => {
  if (!headers) return undefined;
  const context: RequestObservabilityContext = {
    requestId: readHeader(headers, "x-request-id"),
    uiAction: readHeader(headers, "x-ui-action"),
    uiFeature: readHeader(headers, "x-ui-feature"),
    traceparent: readHeader(headers, "traceparent"),
  };
  if (!context.requestId && !context.uiAction && !context.uiFeature && !context.traceparent)
    return undefined;
  return context;
};

const reportHttpError = (args: {
  route: string;
  status: number;
  kind: "db" | "oauth" | "webhook" | "unknown";
  error: unknown;
  context?: RequestObservabilityContext;
}) =>
  recordHttpError({
    route: args.route,
    status: String(args.status),
    kind: args.kind,
  }).pipe(
    Effect.andThen(
      Effect.logError({
        message: "HTTP request failed",
        route: args.route,
        status: args.status,
        kind: args.kind,
        error: args.error instanceof Error ? errorChain(args.error) : String(args.error),
        requestId: args.context?.requestId,
        uiAction: args.context?.uiAction,
        uiFeature: args.context?.uiFeature,
        traceparent: args.context?.traceparent,
      }),
    ),
  );

// The message of each error in the cause chain: Effect.tryPromise wraps the thrown error in
// a generic one whose own message names only tryPromise.
const errorChain = (error: Error): string =>
  error.cause instanceof Error ? `${error.message}: ${errorChain(error.cause)}` : error.message;

// ---------------------------------------------------------------------------
// Kysely → Effect type bridge
// ---------------------------------------------------------------------------

/** Recursively convert JS Date values to Effect DateTime.Utc. */
type DatesToUtc<T> = T extends Date
  ? DateTime.Utc
  : T extends ReadonlyArray<infer U>
    ? DatesToUtc<U>[]
    : T extends object
      ? { [K in keyof T]: DatesToUtc<T[K]> }
      : T;

function datesToUtc<T>(obj: T): DatesToUtc<T> {
  if (obj === null || obj === undefined) return obj as DatesToUtc<T>;
  if (obj instanceof Date) return DateTime.fromDateUnsafe(obj) as DatesToUtc<T>;
  if (Array.isArray(obj)) return obj.map(datesToUtc) as DatesToUtc<T>;
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, datesToUtc(value)]),
    ) as DatesToUtc<T>;
  }
  return obj as DatesToUtc<T>;
}

/**
 * Turn a failed query into the answer for `route`: a known constraint becomes a
 * client error carrying the database's message, anything else a 500.
 *
 * Every failure is translated, so a query whose empty result means "no such
 * thing" belongs in `withDbErrorOrMissing` instead. Raising `NotFound` inside
 * this wrapper answers 500, because the wrapper cannot tell it from a defect.
 */
const withDbError = <A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catch((e) => dbFailure(route, e, headers)),
  );

/** One failed query as the client error or 500 it deserves, reported on the way. */
const dbFailure = (
  route: string,
  cause: unknown,
  headers?: RequestHeaders,
): Effect.Effect<never, ApiError | ServerError> =>
  handleDbError(cause, route).pipe(
    Effect.flatMap(({ code, error }) => {
      const httpError: ApiError | ServerError =
        code >= 500 ? new ServerError({ error }) : new ApiError({ error });
      return Effect.annotateCurrentSpan({
        error: true,
        "error.type": "db",
        "error.message": error,
        "error.operation": route,
        "error.status": code,
      }).pipe(
        Effect.andThen(
          reportHttpError({
            route,
            status: code,
            kind: "db",
            error: cause,
            context: requestObservabilityContext(headers),
          }),
        ),
        Effect.andThen(Effect.fail(httpError)),
      );
    }),
  );

/**
 * `withDbError`, for a query whose empty result means the thing does not exist.
 *
 * The services read single rows with `Effect.head`, which fails with
 * `NoSuchElementError`. Answering that here keeps absence a 404: passed to
 * `withDbError` it is indistinguishable from a broken query and becomes a 500.
 */
const withDbErrorOrMissing = <A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
  missing: string,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | NotFound | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catch((e): Effect.Effect<never, ApiError | NotFound | ServerError> =>
      Cause.isNoSuchElementError(e)
        ? Effect.fail(new NotFound({ error: missing }))
        : dbFailure(route, e, headers),
    ),
  );

/**
 * The edit key a request carries, if any.
 *
 * Like the session cookie, the key is a credential the transport carries rather
 * than data an endpoint declares, so it is read off the request here and handed
 * to the database, which decides whether it holds.
 */
const editKeyFrom = (headers: RequestHeaders): string | null =>
  readHeader(headers, EDIT_KEY_HEADER) ?? null;

/** Require a session, fail with Unauthorized if missing. */
const requireSession = (route: string, headers?: RequestHeaders) =>
  CurrentSession.pipe(
    Effect.flatMap(({ session, user }) => {
      if (!session || !user) {
        return reportHttpError({
          route,
          status: 401,
          kind: "unknown",
          error: "Unauthorized",
          context: requestObservabilityContext(headers),
        }).pipe(Effect.andThen(Effect.fail(new Unauthorized({ error: "Unauthorized" }))));
      }
      return Effect.succeed({ session, user });
    }),
  );

const parseCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [n, ...rest] = part.trim().split("=");
    if (n === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Handlers: auth
// ---------------------------------------------------------------------------

const authLive = HttpApiBuilder.group(PgGardenApi, "auth", (handlers) =>
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

// ---------------------------------------------------------------------------
// Handlers: apiUsers
// ---------------------------------------------------------------------------

const usersLive = HttpApiBuilder.group(PgGardenApi, "apiUsers", (handlers) =>
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

// ---------------------------------------------------------------------------
// Handlers: apiPlaygrounds
// ---------------------------------------------------------------------------

const playgroundsLive = HttpApiBuilder.group(PgGardenApi, "apiPlaygrounds", (handlers) =>
  handlers.handleAll({
    userPlaygrounds: ({ params, query, request }) =>
      withDbError(
        "Failed to list user playgrounds",
        PlaygroundService.use((service) => service.listForUser(params.username, query)),
        request.headers,
      ),
    playgrounds: ({ query, request }) =>
      withDbError(
        "Failed to list playgrounds",
        PlaygroundService.use((service) => service.list(query)),
        request.headers,
      ),
    // A caller with no account may start a playground. The answer then carries
    // the key that holds it, which is the only time the server has it in a form
    // anyone can read.
    createPlayground: ({ payload, request }) =>
      withDbError(
        "Failed to create playground",
        PlaygroundService.use((service) => service.create(payload)).pipe(
          Effect.map((result) => ({
            commit_id: result.commit_id,
            playground_hash: result.playground_hash,
            parent_id: result.parent_id,
            message: result.message,
            created_at: result.created_at,
            edit_key: result.edit_key,
            expires_at: result.expires_at,
          })),
        ),
        request.headers,
      ),
    playgroundByHash: ({ params, request }) =>
      withDbErrorOrMissing(
        "Failed to fetch playground",
        Effect.gen(function* () {
          const pg = yield* PlaygroundService.use((service) => service.getByHash(params.hash));
          return {
            ...pg,
            user: pg.user?.username ? { username: pg.user.username } : null,
          };
        }),
        "Playground not found",
        request.headers,
      ),
    forkPlayground: ({ params, payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.forkPlayground", request.headers);
        return yield* withDbError(
          "Failed to fork playground",
          PlaygroundService.use((service) => service.fork(params.hash, payload.name)),
          request.headers,
        );
      }),
    // A metadata change needs an account or the playground's edit key, and
    // which of the two the caller has is the database's question: the function
    // it calls matches on the session or on the key, and answers with no row
    // when neither holds.
    // Entitlement stays the database's call: the _200_privacy_entitlement
    // trigger refuses 'private' for an anonymous or non-sponsor author and
    // reaches the client as a 400 carrying its own message, the same way
    // creating a playground does.
    updatePlayground: ({ params, payload, request }) =>
      withDbErrorOrMissing(
        "Failed to update playground",
        PlaygroundService.use((service) =>
          service.update(params.hash, payload, editKeyFrom(request.headers)),
        ),
        "Playground not found",
        request.headers,
      ),
    // Saving needs an account or the playground's edit key, and which of the
    // two the caller has is the database's question, not this handler's: it
    // refuses a key that does not match with a 400 carrying its own message.
    createCommit: ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { user } = yield* CurrentSession;
        return yield* withDbErrorOrMissing(
          "Failed to create commit",
          PlaygroundService.use((service) =>
            service.createCommit(
              user?.id ?? null,
              params.hash,
              payload,
              editKeyFrom(request.headers),
            ),
          ),
          "Playground not found",
          request.headers,
        );
      }),
    claimPlayground: ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.claimPlayground", request.headers);
        return yield* withDbError(
          "Failed to claim playground",
          PlaygroundService.use((service) =>
            service.claim(params.hash, editKeyFrom(request.headers)),
          ),
          request.headers,
        );
      }),
    listCommits: ({ params, request }) =>
      withDbError(
        "Failed to fetch playground commits",
        PlaygroundService.use((service) => service.listCommits(params.hash)),
        request.headers,
      ),
    getCommit: ({ params, request }) =>
      withDbErrorOrMissing(
        "Failed to fetch commit",
        PlaygroundService.use((service) => service.getCommit(params.hash, params.commit_id)),
        "Commit not found",
        request.headers,
      ),
    getCommitHistory: ({ params, query, request }) =>
      withDbError(
        "Failed to fetch commit history",
        PlaygroundService.use((service) =>
          service.getCommitHistory(params.hash, params.commit_id, query.limit),
        ),
        request.headers,
      ),
    getCommitDiff: ({ params, request }) =>
      withDbErrorOrMissing(
        "Failed to generate diff",
        PlaygroundService.use((service) => service.getCommitDiff(params.hash, params.commit_id)),
        "Commit not found",
        request.headers,
      ),
    togglePlaygroundStar: ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.togglePlaygroundStar", request.headers);
        return yield* withDbError(
          "Failed to toggle star",
          PlaygroundService.use((service) => service.toggleStar(params.hash)),
          request.headers,
        );
      }),
    deletePlayground: ({ params, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.deletePlayground", request.headers);
        return yield* withDbErrorOrMissing(
          "Failed to delete playground",
          PlaygroundService.use((service) => service.deletePlayground(params.hash)).pipe(
            Effect.map((result) => ({ hash: result.hash })),
          ),
          "Playground not found",
          request.headers,
        );
      }),
    searchPlaygrounds: ({ query, request }) =>
      withDbError(
        "Failed to search playgrounds",
        PlaygroundService.use((service) =>
          service.search(query.q ?? "", query.limit, query.offset),
        ),
        request.headers,
      ),
  }),
);

// ---------------------------------------------------------------------------
// Handlers: webhooks
// ---------------------------------------------------------------------------

const webhookLive = HttpApiBuilder.group(PgGardenApi, "webhooks", (handlers) =>
  handlers.handleRaw("githubSponsorWebhook", ({ request }) => {
    const event = (request.headers["x-github-event"] as string | undefined) ?? null;
    const signature = (request.headers["x-hub-signature-256"] as string | undefined) ?? null;
    return Effect.gen(function* () {
      const body = yield* request.text;
      const result = yield* WebhookService.use((service) =>
        service.handleGitHubSponsor(signature, body, event),
      );
      yield* recordWebhook({
        provider: "github",
        event: event ?? "unknown",
        verified: "true",
      });
      return HttpServerResponse.jsonUnsafe(result);
    }).pipe(
      Effect.catch((e) => {
        if (S.is(WebhookNotConfiguredError)(e)) {
          return recordWebhook({
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          }).pipe(
            Effect.andThen(
              reportHttpError({
                route: "webhooks.githubSponsorWebhook",
                status: 503,
                kind: "webhook",
                error: e,
                context: requestObservabilityContext(request.headers),
              }).pipe(
                Effect.as(
                  HttpServerResponse.jsonUnsafe(
                    { error: "Webhook not configured" },
                    { status: 503 },
                  ),
                ),
              ),
            ),
          );
        }
        if (S.is(WebhookVerificationError)(e)) {
          return recordWebhook({
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          }).pipe(
            Effect.andThen(
              reportHttpError({
                route: "webhooks.githubSponsorWebhook",
                status: 401,
                kind: "webhook",
                error: e,
                context: requestObservabilityContext(request.headers),
              }).pipe(
                Effect.as(
                  HttpServerResponse.jsonUnsafe({ error: "Invalid signature" }, { status: 401 }),
                ),
              ),
            ),
          );
        }
        return handleDbError(e, "Webhook processing failed").pipe(
          Effect.flatMap(({ code, error }) =>
            reportHttpError({
              route: "webhooks.githubSponsorWebhook",
              status: code,
              kind: "webhook",
              error: e,
              context: requestObservabilityContext(request.headers),
            }).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ error }, { status: code }))),
          ),
        );
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Handlers: system
// ---------------------------------------------------------------------------

const systemLive = HttpApiBuilder.group(PgGardenApi, "system", (handlers) =>
  handlers.handleRaw("healthz", () =>
    Effect.flatMap(deployedCommit, (commit) => {
      const respond = (status: 200 | 503, body: HealthBody) =>
        HttpServerResponse.jsonUnsafe(body, {
          status,
          headers: { "x-commit": commit, "cache-control": "no-store" },
        });
      return checkDependencies.pipe(
        Effect.as(respond(200, { status: "ok", commit })),
        Effect.catchTag("DependencyUnavailable", (e) =>
          // The error text stays in the logs: this route is unauthenticated.
          Effect.logWarning(`healthz: ${e.dependency} unavailable: ${e.message}`).pipe(
            Effect.as(
              respond(503, { status: "error", commit, failed: [healthName(e.dependency)] }),
            ),
          ),
        ),
      );
    }),
  ),
);

type HealthBody =
  | { readonly status: "ok"; readonly commit: string }
  | { readonly status: "error"; readonly commit: string; readonly failed: ReadonlyArray<string> };

/** The health contract names both Postgres pools "database"; other probes keep their name. */
const healthName = (dependency: string) =>
  dependency.startsWith("postgres") ? "database" : dependency;

/** The commit the deploy runs, for the health body; the platform sets GIT_COMMIT. */
const deployedCommit = Config.String("GIT_COMMIT").pipe(Effect.orElseSucceed(() => "unknown"));

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const HttpApiHandlers = HttpApiBuilder.layer(PgGardenApi).pipe(
  Layer.provide(authLive),
  Layer.provide(usersLive),
  Layer.provide(playgroundsLive),
  Layer.provide(webhookLive),
  Layer.provide(systemLive),
);

// One layer value, used twice: `Layer.provide` satisfies the plain requirements of
// the middleware and handlers, and `HttpRouter.provideRequest` satisfies the
// request-scoped `Requires` markers, which `Layer.provide` leaves unsatisfied.
// Layer memoization builds each service and pool once.
const RequestServices = Layer.mergeAll(
  Cookies.layer,
  AuthService.layer,
  UserService.layer,
  PlaygroundService.layer,
  SessionService.layer,
  OAuthService.layer,
  WebhookService.layer,
  // The health check pings Valkey inside a handler, so the server's one client
  // is lifted from the layer context into the request context.
  Layer.effect(Redis, Redis.use(Effect.succeed)),
).pipe(Layer.provideMerge(DatabaseLive));

export const HttpApiLive = HttpApiHandlers.pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provide(RequestServices),
  HttpRouter.provideRequest(RequestServices),
);
