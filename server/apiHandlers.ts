import { DateTime, Effect, Layer, Schema as S } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { CurrentSession, PgGardenApi } from "./apiSchema.js";
import { DatabaseLive, handleDbError } from "./db.js";
import {
  ApiError,
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  ServerError,
  Unauthorized,
} from "./errors.js";
import {
  recordActiveSessions,
  recordAuthAttempt,
  recordHttpError,
  recordWebhook,
} from "./metrics.js";
import { AuthService } from "./services/authService.js";
import { makeExpiredNamedCookie, makeOAuthCookie } from "./services/cookies.js";
import {
  OAuthCallbackError,
  OAuthNotConfiguredError,
  OAuthService,
} from "./services/oauthService.js";
import { PlaygroundService } from "./services/playgroundService.js";
import {
  expireSessionCookie,
  SessionMiddlewareLive,
  setSessionCookie,
} from "./services/sessionMiddleware.js";
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

/** Catch SQL/DB errors and map to ApiError or ServerError. */
const withDbError = <A, E, R>(
  route: string,
  effect: Effect.Effect<A, E, R>,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catch((e) =>
      handleDbError(e, route).pipe(
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
                error: e,
                context: requestObservabilityContext(headers),
              }),
            ),
            Effect.andThen(Effect.fail(httpError)),
          );
        }),
      ),
    ),
  );

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

const buildOAuthSuccessHtml = (authData: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Authentication Successful</title>
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
  <div class="container">
    <div class="success-icon">✓</div>
    <h1>Authentication Successful!</h1>
    <p>Returning to the application<span class="spinner"></span></p>
  </div>
  <script>
    (function () {
      var authData = ${authData};
      try {
        var storageKey = "github-auth-result";
        var authResult = JSON.stringify({ type: "github-auth-success", user: authData, timestamp: Date.now() });
        localStorage.setItem(storageKey, authResult);
        if (typeof BroadcastChannel !== "undefined") {
          var channel = new BroadcastChannel("github-auth");
          channel.postMessage({ type: "github-auth-success", user: authData });
          channel.close();
        }
        if (window.opener && !window.opener.closed) {
          try { window.opener.postMessage({ type: "github-auth-success", user: authData }, window.location.origin); } catch (e) {}
        }
        localStorage.setItem("github-auth-trigger", String(Date.now()));
        localStorage.removeItem("github-auth-trigger");
        document.querySelector("p").textContent = "Authentication successful! Closing window...";
        setTimeout(function () { window.close(); }, 500);
      } catch (error) {
        console.error("Failed to communicate auth result:", error);
        document.querySelector("p").textContent = "Authentication successful! Please close this window.";
      }
    })();
  </script>
</body>
</html>`;

const STATE_COOKIE = "github_oauth_state";

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
              Effect.andThen(setSessionCookie(token, expiresAt)),
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
              Effect.andThen(setSessionCookie(token, expiresAt)),
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
      authMe: () =>
        CurrentSession.pipe(
          Effect.map(({ user }) =>
            user
              ? {
                  ...user,
                  role: user.role as "user" | "sponsor" | "pro" | "admin",
                }
              : null,
          ),
        ),
      logout: () =>
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          yield* AuthService.use((service) => service.logout(session?.cookie_id));
          yield* recordActiveSessions(-1);
          yield* expireSessionCookie;
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
        const headers: Record<string, string> = {};
        headers["Set-Cookie"] = makeOAuthCookie(STATE_COOKIE, result.state);
        return HttpServerResponse.empty({
          status: 302,
          headers: { Location: result.url.toString(), ...headers },
        });
      }).pipe(
        Effect.catch((e) => {
          if (S.is(OAuthNotConfiguredError)(e)) {
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "GitHub OAuth is not configured" },
                { status: 503 },
              ),
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
              ).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ error }, { status: code }))),
            ),
          );
        }),
      ),
    )
    .handleRaw("authGithubCallback", ({ query, request }) =>
      Effect.gen(function* () {
        const storedState = parseCookie(request.headers.cookie, STATE_COOKIE);
        if (!storedState || query.state !== storedState) {
          return HttpServerResponse.jsonUnsafe(
            { error: "Invalid state parameter" },
            { status: 400 },
          );
        }

        const { session: currentSession } = yield* CurrentSession;
        const result = yield* OAuthService.use((service) =>
          service.handleCallback(query.code, currentSession?.user_id),
        );

        yield* recordAuthAttempt({
          method: "github",
          action: "oauth",
          result: "success",
        });
        if (result.isNewSession) {
          yield* recordActiveSessions(1);
        }

        const authData = yield* S.encodeEffect(S.fromJsonString(S.Unknown))({
          id: result.user.id,
          username: result.user.username,
          role: result.user.role,
        });
        const html = buildOAuthSuccessHtml(authData);
        const cookieHeader = result.setCookie ?? makeExpiredNamedCookie(STATE_COOKIE);

        return HttpServerResponse.text(html, {
          status: 200,
          contentType: "text/html",
          headers: { "Set-Cookie": cookieHeader },
        });
      }).pipe(
        Effect.catch((e) => {
          if (S.is(OAuthCallbackError)(e)) {
            if (e.isBadCode) {
              return recordAuthAttempt({
                method: "github",
                action: "oauth",
                result: "bad_verification_code",
              }).pipe(
                Effect.andThen(
                  Effect.succeed(
                    HttpServerResponse.jsonUnsafe(
                      { error: "Bad verification code" },
                      { status: 400 },
                    ),
                  ),
                ),
              );
            }
            return recordAuthAttempt({
              method: "github",
              action: "oauth",
              result: "error",
            }).pipe(
              Effect.andThen(
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe({ error: e.message }, { status: 400 }),
                ),
              ),
            );
          }
          if (S.is(OAuthNotConfiguredError)(e)) {
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "GitHub OAuth is not configured" },
                { status: 503 },
              ),
            );
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
              ).pipe(Effect.as(HttpServerResponse.jsonUnsafe({ error }, { status: code }))),
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
        return {
          user: profile
            ? {
                ...profile,
                role: profile.role as "user" | "sponsor" | "pro" | "admin",
              }
            : null,
        };
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
        return yield* withDbError(
          "Failed to update profile",
          UserService.use((service) => service.updateProfile(payload)).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "User not found" })),
            ),
          ),
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
        return yield* withDbError(
          "Failed to delete email",
          UserService.use((service) => service.deleteEmail(params.id)).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "Email not found" })),
            ),
          ),
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
        return yield* withDbError(
          "Failed to delete authentication",
          UserService.use((service) => service.unlinkAuthentication(params.id)).pipe(
            Effect.map((result) => ({ id: result.id })),
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "Authentication not found" })),
            ),
          ),
          request.headers,
        );
      }),
    meHasPassword: ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meHasPassword", request.headers);
        return yield* withDbError(
          "Failed to check password",
          UserService.use((service) => service.hasPassword).pipe(
            Effect.map((result) => ({ has_password: result.has_password })),
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "User not found" })),
            ),
          ),
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
    createPlayground: ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.createPlayground", request.headers);
        return yield* withDbError(
          "Failed to create playground",
          PlaygroundService.use((service) => service.create(payload)).pipe(
            Effect.map((result) => ({
              commit_id: result.commit_id,
              playground_hash: result.playground_hash,
              parent_id: result.parent_id,
              message: result.message,
              created_at: result.created_at,
            })),
          ),
          request.headers,
        );
      }),
    playgroundByHash: ({ params, request }) =>
      withDbError(
        "Failed to fetch playground",
        Effect.gen(function* () {
          const pg = yield* PlaygroundService.use((service) => service.getByHash(params.hash));
          return {
            ...pg,
            user: pg.user?.username ? { username: pg.user.username } : null,
          };
        }).pipe(
          Effect.catchTag("NoSuchElementError", () =>
            Effect.fail(new NotFound({ error: "Playground not found" })),
          ),
        ),
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
    updatePlayground: ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { user } = yield* requireSession("apiPlaygrounds.updatePlayground", request.headers);
        if (payload.privacy === "private" && !["sponsor", "pro", "admin"].includes(user.role)) {
          return yield* reportHttpError({
            route: "apiPlaygrounds.updatePlayground",
            status: 403,
            kind: "unknown",
            error: "Private playgrounds require a sponsor account",
            context: requestObservabilityContext(request.headers),
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new Forbidden({
                  error: "Private playgrounds require a sponsor account",
                }),
              ),
            ),
          );
        }
        return yield* withDbError(
          "Failed to update playground",
          PlaygroundService.use((service) => service.update(params.hash, payload)).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
          request.headers,
        );
      }),
    createCommit: ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { user } = yield* requireSession("apiPlaygrounds.createCommit", request.headers);
        return yield* withDbError(
          "Failed to create commit",
          PlaygroundService.use((service) =>
            service.createCommit(user.id, params.hash, payload),
          ).pipe(
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
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
      withDbError(
        "Failed to fetch commit",
        PlaygroundService.use((service) => service.getCommit(params.hash, params.commit_id)).pipe(
          Effect.catchTag("NoSuchElementError", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
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
      withDbError(
        "Failed to generate diff",
        PlaygroundService.use((service) =>
          service.getCommitDiff(params.hash, params.commit_id),
        ).pipe(
          Effect.catchTag("NoSuchElementError", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
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
        return yield* withDbError(
          "Failed to delete playground",
          PlaygroundService.use((service) => service.deletePlayground(params.hash)).pipe(
            Effect.map((result) => ({ hash: result.hash })),
            Effect.catchTag("NoSuchElementError", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
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
  handlers.handleAll({
    healthz: () => Effect.succeed({ ok: true }),
  }),
);

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
  AuthService.layer,
  UserService.layer,
  PlaygroundService.layer,
  SessionService.layer,
  OAuthService.layer,
  WebhookService.layer,
).pipe(Layer.provideMerge(DatabaseLive));

export const HttpApiLive = HttpApiHandlers.pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provide(RequestServices),
  HttpRouter.provideRequest(RequestServices),
);
