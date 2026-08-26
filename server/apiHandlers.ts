import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { DateTime, Effect, Layer } from "effect";
import * as S from "effect/Schema";
import { CurrentSession, PgGardenApi } from "./apiSchema.js";
import { handleDbError } from "./db.js";
import {
  ApiError,
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  ServerError,
  Unauthorized,
} from "./errors.js";
import { authActiveSessions, authAttempts, httpErrors, webhookReceived } from "./metrics.js";
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
  Effect.sync(() => {
    httpErrors.add(1, {
      route: args.route,
      status: String(args.status),
      kind: args.kind,
    });
  }).pipe(
    Effect.zipRight(
      Effect.logError({
        message: "HTTP request failed",
        route: args.route,
        status: args.status,
        kind: args.kind,
        error: args.error instanceof Error ? args.error.message : String(args.error),
        requestId: args.context?.requestId,
        uiAction: args.context?.uiAction,
        uiFeature: args.context?.uiFeature,
        traceparent: args.context?.traceparent,
      }),
    ),
  );

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
  if (obj instanceof Date) return DateTime.unsafeFromDate(obj) as DatesToUtc<T>;
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
    Effect.catchAll((e) => {
      const { code, error } = handleDbError(e, route);
      const httpError: ApiError | ServerError =
        code >= 500 ? new ServerError({ error }) : new ApiError({ error });
      return Effect.annotateCurrentSpan({
        error: true,
        "error.type": "db",
        "error.message": error,
        "error.operation": route,
        "error.status": code,
      }).pipe(
        Effect.zipRight(
          reportHttpError({
            route,
            status: code,
            kind: "db",
            error: e,
            context: requestObservabilityContext(headers),
          }),
        ),
        Effect.zipRight(Effect.fail(httpError)),
      );
    }),
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
        }).pipe(Effect.zipRight(Effect.fail(new Unauthorized({ error: "Unauthorized" }))));
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
    .handle("register", ({ payload }) =>
      AuthService.register(payload).pipe(
        Effect.tap(({ token, expiresAt }) => {
          authAttempts.add(1, {
            method: "password",
            action: "register",
            result: "success",
          });
          authActiveSessions.add(1);
          return setSessionCookie(token, expiresAt);
        }),
        Effect.map((result) => ({
          ...datesToUtc(result.user),
          bio: result.user.bio ?? "",
        })),
        Effect.catchTags({
          DuplicateAccount: (e) => {
            authAttempts.add(1, {
              method: "password",
              action: "register",
              result: "duplicate",
            });
            return Effect.fail(new Conflict({ error: e.message }));
          },
          MissingData: (e) => {
            authAttempts.add(1, {
              method: "password",
              action: "register",
              result: "error",
            });
            return Effect.fail(new ApiError({ error: e.message }));
          },
          WeakPassword: (e) => {
            authAttempts.add(1, {
              method: "password",
              action: "register",
              result: "error",
            });
            return Effect.fail(new ApiError({ error: e.message }));
          },
        }),
      ),
    )
    .handle("login", ({ payload }) =>
      AuthService.login(payload).pipe(
        Effect.tap(({ token, expiresAt }) => {
          authAttempts.add(1, {
            method: "password",
            action: "login",
            result: "success",
          });
          authActiveSessions.add(1);
          return setSessionCookie(token, expiresAt);
        }),
        Effect.map((result) => ({
          ...datesToUtc(result.user),
          bio: result.user.bio ?? "",
        })),
        Effect.catchTags({
          InvalidCredentials: (e) => {
            authAttempts.add(1, {
              method: "password",
              action: "login",
              result: "invalid",
            });
            return Effect.fail(new Unauthorized({ error: e.message }));
          },
          AccountLocked: (e) => {
            authAttempts.add(1, {
              method: "password",
              action: "login",
              result: "locked",
            });
            return Effect.fail(new Locked({ error: e.message }));
          },
        }),
      ),
    )
    .handle("authMe", () =>
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
    )
    .handle("logout", () =>
      Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        yield* AuthService.logout(session?.cookie_id);
        authActiveSessions.add(-1);
        yield* expireSessionCookie;
        return { success: true as const };
      }).pipe(
        Effect.catchAll((e) => {
          const { code, error } = handleDbError(e, "Logout failed");
          const httpError: ApiError | ServerError =
            code >= 500 ? new ServerError({ error }) : new ApiError({ error });
          return reportHttpError({
            route: "logout",
            status: code,
            kind: "unknown",
            error: e,
          }).pipe(Effect.zipRight(Effect.fail(httpError)));
        }),
      ),
    )
    .handleRaw("authGithubStart", ({ request }) =>
      Effect.gen(function* () {
        const result = yield* OAuthService.createAuthorizationUrl(["user:email"]);
        const headers: Record<string, string> = {};
        headers["Set-Cookie"] = makeOAuthCookie(STATE_COOKIE, result.state);
        return HttpServerResponse.empty({
          status: 302,
          headers: { Location: result.url.toString(), ...headers },
        });
      }).pipe(
        Effect.catchAll((e) => {
          if (S.is(OAuthNotConfiguredError)(e)) {
            return Effect.succeed(
              HttpServerResponse.unsafeJson(
                { error: "GitHub OAuth is not configured" },
                { status: 503 },
              ),
            );
          }
          const { code, error } = handleDbError(e, "OAuth error");
          return (
            code >= 400
              ? reportHttpError({
                  route: "authGithubStart",
                  status: code,
                  kind: "oauth",
                  error: e,
                  context: requestObservabilityContext(request.headers),
                })
              : Effect.void
          ).pipe(Effect.as(HttpServerResponse.unsafeJson({ error }, { status: code })));
        }),
      ),
    )
    .handleRaw("authGithubCallback", ({ urlParams, request }) =>
      Effect.gen(function* () {
        const storedState = parseCookie(request.headers.cookie, STATE_COOKIE);
        if (!storedState || urlParams.state !== storedState) {
          return HttpServerResponse.unsafeJson(
            { error: "Invalid state parameter" },
            { status: 400 },
          );
        }

        const { session: currentSession } = yield* CurrentSession;
        const result = yield* OAuthService.handleCallback(urlParams.code, currentSession?.user_id);

        authAttempts.add(1, {
          method: "github",
          action: "oauth",
          result: "success",
        });
        if (result.isNewSession) {
          authActiveSessions.add(1);
        }

        const authData = yield* S.encode(S.parseJson(S.Unknown))({
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
        Effect.catchAll((e) => {
          if (S.is(OAuthCallbackError)(e)) {
            if (e.isBadCode) {
              authAttempts.add(1, {
                method: "github",
                action: "oauth",
                result: "bad_verification_code",
              });
              return Effect.succeed(
                HttpServerResponse.unsafeJson({ error: "Bad verification code" }, { status: 400 }),
              );
            }
            authAttempts.add(1, {
              method: "github",
              action: "oauth",
              result: "error",
            });
            return Effect.succeed(
              HttpServerResponse.unsafeJson({ error: e.message }, { status: 400 }),
            );
          }
          if (S.is(OAuthNotConfiguredError)(e)) {
            return Effect.succeed(
              HttpServerResponse.unsafeJson(
                { error: "GitHub OAuth is not configured" },
                { status: 503 },
              ),
            );
          }
          authAttempts.add(1, {
            method: "github",
            action: "oauth",
            result: "error",
          });
          const { code, error } = handleDbError(e, "OAuth error");
          return (
            code >= 400
              ? reportHttpError({
                  route: "authGithubCallback",
                  status: code,
                  kind: "oauth",
                  error: e,
                  context: requestObservabilityContext(request.headers),
                })
              : Effect.void
          ).pipe(Effect.as(HttpServerResponse.unsafeJson({ error }, { status: code })));
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Handlers: apiUsers
// ---------------------------------------------------------------------------

const usersLive = HttpApiBuilder.group(PgGardenApi, "apiUsers", (handlers) =>
  handlers
    .handle("me", ({ request }) =>
      Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        if (!session) return { user: null };
        const profile = yield* withDbError(
          "Failed to fetch profile",
          UserService.getProfile(),
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
    )
    .handle("deleteMe", ({ urlParams, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMe", request.headers);
        const success = yield* withDbError(
          "Account deletion failed",
          UserService.requestAccountDeletion(urlParams.token),
          request.headers,
        );
        return { success };
      }),
    )
    .handle("patchMe", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.patchMe", request.headers);
        return yield* withDbError(
          "Failed to update profile",
          UserService.updateProfile(payload).pipe(
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "User not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("meEmails", ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meEmails", request.headers);
        return yield* withDbError(
          "Failed to fetch emails",
          UserService.listEmails(),
          request.headers,
        );
      }),
    )
    .handle("createMeEmail", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.createMeEmail", request.headers);
        return yield* withDbError(
          "Failed to add email",
          UserService.addEmail(payload.email),
          request.headers,
        );
      }),
    )
    .handle("deleteMeEmail", ({ path, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMeEmail", request.headers);
        return yield* withDbError(
          "Failed to delete email",
          UserService.deleteEmail(path.id).pipe(
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Email not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("meAuthentications", ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meAuthentications", request.headers);
        return yield* withDbError(
          "Failed to fetch authentications",
          UserService.listAuthentications(),
          request.headers,
        );
      }),
    )
    .handle("deleteMeAuthentication", ({ path, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.deleteMeAuthentication", request.headers);
        return yield* withDbError(
          "Failed to delete authentication",
          UserService.unlinkAuthentication(path.id).pipe(
            Effect.map((result) => ({ id: result.id })),
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Authentication not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("meHasPassword", ({ request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.meHasPassword", request.headers);
        return yield* withDbError(
          "Failed to check password",
          UserService.hasPassword().pipe(
            Effect.map((result) => ({ has_password: result.has_password })),
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "User not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("forgotPassword", ({ payload, request }) =>
      withDbError(
        "Failed to send password reset",
        UserService.forgotPassword(payload.email).pipe(Effect.as({ success: true as const })),
        request.headers,
      ),
    )
    .handle("resetPassword", ({ payload, request }) =>
      withDbError(
        "Failed to reset password",
        UserService.resetPassword(payload.userId, payload.token, payload.password),
        request.headers,
      ),
    )
    .handle("changePassword", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.changePassword", request.headers);
        return yield* withDbError(
          "Failed to change password",
          UserService.changePassword(payload.oldPassword, payload.newPassword),
          request.headers,
        );
      }),
    )
    .handle("verifyEmail", ({ payload, request }) =>
      withDbError(
        "Failed to verify email",
        UserService.verifyEmail(payload.emailId, payload.token),
        request.headers,
      ),
    )
    .handle("makeEmailPrimary", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.makeEmailPrimary", request.headers);
        return yield* withDbError(
          "Failed to update primary email",
          UserService.makeEmailPrimary(payload.emailId),
          request.headers,
        );
      }),
    )
    .handle("resendEmailVerificationCode", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiUsers.resendEmailVerificationCode", request.headers);
        return yield* withDbError(
          "Failed to resend verification",
          UserService.resendEmailVerificationCode(payload.emailId),
          request.headers,
        );
      }),
    ),
);

// ---------------------------------------------------------------------------
// Handlers: apiPlaygrounds
// ---------------------------------------------------------------------------

const playgroundsLive = HttpApiBuilder.group(PgGardenApi, "apiPlaygrounds", (handlers) =>
  handlers
    .handle("userPlaygrounds", ({ path, urlParams, request }) =>
      withDbError(
        "Failed to list user playgrounds",
        PlaygroundService.listForUser(path.username, urlParams),
        request.headers,
      ),
    )
    .handle("playgrounds", ({ urlParams, request }) =>
      withDbError("Failed to list playgrounds", PlaygroundService.list(urlParams), request.headers),
    )
    .handle("createPlayground", ({ payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.createPlayground", request.headers);
        return yield* withDbError(
          "Failed to create playground",
          PlaygroundService.create(payload).pipe(
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
    )
    .handle("playgroundByHash", ({ path, request }) =>
      withDbError(
        "Failed to fetch playground",
        Effect.gen(function* () {
          const pg = yield* PlaygroundService.getByHash(path.hash);
          return {
            ...pg,
            user: pg.user?.username ? { username: pg.user.username } : null,
          };
        }).pipe(
          Effect.catchTag("NoSuchElementException", () =>
            Effect.fail(new NotFound({ error: "Playground not found" })),
          ),
        ),
        request.headers,
      ),
    )
    .handle("forkPlayground", ({ path, payload, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.forkPlayground", request.headers);
        return yield* withDbError(
          "Failed to fork playground",
          PlaygroundService.fork(path.hash, payload.name).pipe(
            Effect.map((result) => ({
              commit_id: result.commit_id,
              playground_id: result.playground_id,
              parent_id: result.parent_id,
              message: result.message,
              created_at: result.created_at,
            })),
          ),
          request.headers,
        );
      }),
    )
    .handle("updatePlayground", ({ path, payload, request }) =>
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
            Effect.zipRight(
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
          PlaygroundService.update(path.hash, payload).pipe(
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("createCommit", ({ path, payload, request }) =>
      Effect.gen(function* () {
        const { user } = yield* requireSession("apiPlaygrounds.createCommit", request.headers);
        return yield* withDbError(
          "Failed to create commit",
          PlaygroundService.createCommit(user.id, path.hash, payload).pipe(
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("listCommits", ({ path, request }) =>
      withDbError(
        "Failed to fetch playground commits",
        PlaygroundService.listCommits(path.hash),
        request.headers,
      ),
    )
    .handle("getCommit", ({ path, request }) =>
      withDbError(
        "Failed to fetch commit",
        PlaygroundService.getCommit(path.hash, path.commit_id).pipe(
          Effect.catchTag("NoSuchElementException", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
        request.headers,
      ),
    )
    .handle("getCommitHistory", ({ path, urlParams, request }) =>
      withDbError(
        "Failed to fetch commit history",
        PlaygroundService.getCommitHistory(path.hash, path.commit_id, urlParams.limit),
        request.headers,
      ),
    )
    .handle("getCommitDiff", ({ path, request }) =>
      withDbError(
        "Failed to generate diff",
        PlaygroundService.getCommitDiff(path.hash, path.commit_id).pipe(
          Effect.catchTag("NoSuchElementException", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
        request.headers,
      ),
    )
    .handle("togglePlaygroundStar", ({ path, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.togglePlaygroundStar", request.headers);
        return yield* withDbError(
          "Failed to toggle star",
          PlaygroundService.toggleStar(path.hash),
          request.headers,
        );
      }),
    )
    .handle("deletePlayground", ({ path, request }) =>
      Effect.gen(function* () {
        yield* requireSession("apiPlaygrounds.deletePlayground", request.headers);
        return yield* withDbError(
          "Failed to delete playground",
          PlaygroundService.deletePlayground(path.hash).pipe(
            Effect.map((result) => ({ hash: result.hash })),
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("searchPlaygrounds", ({ urlParams, request }) =>
      withDbError(
        "Failed to search playgrounds",
        PlaygroundService.search(urlParams.q ?? "", urlParams.limit, urlParams.offset),
        request.headers,
      ),
    ),
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
      const result = yield* WebhookService.handleGitHubSponsor(signature, body, event);
      webhookReceived.add(1, {
        provider: "github",
        event: event ?? "unknown",
        verified: "true",
      });
      return HttpServerResponse.unsafeJson(result);
    }).pipe(
      Effect.catchAll((e) => {
        if (S.is(WebhookNotConfiguredError)(e)) {
          webhookReceived.add(1, {
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          });
          return reportHttpError({
            route: "webhooks.githubSponsorWebhook",
            status: 503,
            kind: "webhook",
            error: e,
            context: requestObservabilityContext(request.headers),
          }).pipe(
            Effect.as(
              HttpServerResponse.unsafeJson({ error: "Webhook not configured" }, { status: 503 }),
            ),
          );
        }
        if (S.is(WebhookVerificationError)(e)) {
          webhookReceived.add(1, {
            provider: "github",
            event: event ?? "unknown",
            verified: "false",
          });
          return reportHttpError({
            route: "webhooks.githubSponsorWebhook",
            status: 401,
            kind: "webhook",
            error: e,
            context: requestObservabilityContext(request.headers),
          }).pipe(
            Effect.as(
              HttpServerResponse.unsafeJson({ error: "Invalid signature" }, { status: 401 }),
            ),
          );
        }
        const { code, error } = handleDbError(e, "Webhook processing failed");
        return reportHttpError({
          route: "webhooks.githubSponsorWebhook",
          status: code,
          kind: "webhook",
          error: e,
          context: requestObservabilityContext(request.headers),
        }).pipe(Effect.as(HttpServerResponse.unsafeJson({ error }, { status: code })));
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Handlers: system
// ---------------------------------------------------------------------------

const systemLive = HttpApiBuilder.group(PgGardenApi, "system", (handlers) =>
  handlers.handle("healthz", () => Effect.succeed({ ok: true })),
);

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const HttpApiHandlers = HttpApiBuilder.api(PgGardenApi).pipe(
  Layer.provide(authLive),
  Layer.provide(usersLive),
  Layer.provide(playgroundsLive),
  Layer.provide(webhookLive),
  Layer.provide(systemLive),
  Layer.provide(SessionMiddlewareLive),
);

export const HttpApiLive = HttpApiHandlers.pipe(
  Layer.provide(AuthService.Default),
  Layer.provide(UserService.Default),
  Layer.provide(PlaygroundService.Default),
  Layer.provide(SessionService.Default),
  Layer.provide(OAuthService.Default),
  Layer.provide(WebhookService.Default),
);
