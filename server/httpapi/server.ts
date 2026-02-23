import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpMiddleware,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { DateTime, Effect, Layer, Schema } from "effect";
import { createServer } from "node:http";
import { env } from "../assertEnv.js";
import { handleDbError, PgRootDB, PgAuthDB } from "../db.js";
import { waitForDependencies } from "../ready.js";
import { TelemetryLive } from "../telemetry.js";
import { authAttempts, authActiveSessions, webhookReceived, httpErrors } from "../metrics.js";
import { AuthService } from "../services/authService.js";
import { PlaygroundService } from "../services/playgroundService.js";
import { SessionService } from "../services/sessionService.js";
import { UserService } from "../services/userService.js";
import { OAuthService, OAuthNotConfiguredError, OAuthCallbackError } from "../services/oauthService.js";
import { WebhookService, WebhookNotConfiguredError, WebhookVerificationError } from "../services/webhookService.js";
import { makeOAuthCookie, makeExpiredNamedCookie } from "../services/cookies.js";
import {
  CurrentSession,
  SessionMiddleware,
  SessionMiddlewareLive,
  setSessionCookie,
  expireSessionCookie,
} from "../services/sessionMiddleware.js";
import {
  SessionUser,
  UserProfile,
  UserEmailResponse,
  UserAuthenticationResponse,
  HasPasswordResponse,
  PlaygroundListItem,
  PlaygroundListItemWithUser,
  PlaygroundDetail,
  PlaygroundRow,
  CreatePlaygroundResult,
  ForkPlaygroundResult,
  CreateCommitResult,
  CommitListItem,
  CommitDetail,
  CommitHistoryResponse,
  CommitDiffResponse,
  ToggleStarResponse,
  DeletePlaygroundResponse,
} from "./contract.js";
import { Privacy } from "../../generated/privacy.js";

// ---------------------------------------------------------------------------
// HTTP error types — used with addError() so the platform encodes responses
// ---------------------------------------------------------------------------

class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  error: Schema.String,
}) {
  static readonly status = 400 as const;
}

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  error: Schema.String,
}) {
  static readonly status = 401 as const;
}

class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  error: Schema.String,
}) {
  static readonly status = 403 as const;
}

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  error: Schema.String,
}) {
  static readonly status = 404 as const;
}

class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  error: Schema.String,
}) {
  static readonly status = 409 as const;
}

class Locked extends Schema.TaggedError<Locked>()("Locked", {
  error: Schema.String,
}) {
  static readonly status = 423 as const;
}

class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  error: Schema.String,
}) {
  static readonly status = 500 as const;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Unknown = Schema.Unknown;

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

const requestObservabilityContext = (headers: RequestHeaders | undefined): RequestObservabilityContext | undefined => {
  if (!headers) return undefined;
  const context: RequestObservabilityContext = {
    requestId: readHeader(headers, "x-request-id"),
    uiAction: readHeader(headers, "x-ui-action"),
    uiFeature: readHeader(headers, "x-ui-feature"),
    traceparent: readHeader(headers, "traceparent"),
  };
  if (!context.requestId && !context.uiAction && !context.uiFeature && !context.traceparent) return undefined;
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
type DatesToUtc<T> =
  T extends Date ? DateTime.Utc
    : T extends ReadonlyArray<infer U> ? DatesToUtc<U>[]
    : T extends Record<string, unknown> ? { [K in keyof T]: DatesToUtc<T[K]> }
    : T;

function datesToUtc<T>(obj: T): DatesToUtc<T> {
  if (obj === null || obj === undefined) return obj as DatesToUtc<T>;
  if (obj instanceof Date) return DateTime.unsafeFromDate(obj) as DatesToUtc<T>;
  if (Array.isArray(obj)) return obj.map(datesToUtc) as DatesToUtc<T>;
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = datesToUtc(v);
    }
    return result as DatesToUtc<T>;
  }
  return obj as DatesToUtc<T>;
}

/** Catch SQL/DB errors and map to ApiError or ServerError. */
const withDbError = <A, R>(
  route: string,
  effect: Effect.Effect<A, unknown, R>,
  headers?: RequestHeaders,
): Effect.Effect<DatesToUtc<A>, ApiError | ServerError, R> =>
  effect.pipe(
    Effect.map(datesToUtc),
    Effect.catchAll((e) => {
      const { code, error } = handleDbError(e, route);
      const httpError: ApiError | ServerError =
        code >= 500 ? new ServerError({ error }) : new ApiError({ error });
      return Effect.annotateCurrentSpan({
        "error": true,
        "error.type": "db",
        "error.message": error,
        "error.operation": route,
        "error.status": code,
      }).pipe(
        Effect.zipRight(reportHttpError({
          route,
          status: code,
          kind: "db",
          error: e,
          context: requestObservabilityContext(headers),
        })),
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
// Endpoint definitions (server-side, with error types)
// ---------------------------------------------------------------------------

const queryPagination = Schema.Struct({
  offset: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.Union(Schema.Literal("created_at"), Schema.Literal("updated_at"), Schema.Literal("stars"))),
});

const userPath = HttpApiSchema.param("username", Schema.String);
const hashPath = HttpApiSchema.param("hash", Schema.String);
const emailIdPath = HttpApiSchema.param("id", Schema.String);
const commitIdPath = HttpApiSchema.param("commit_id", Schema.String);

const SuccessResponse = Schema.Struct({ success: Schema.Boolean });
const PlaygroundFile = Schema.Struct({ path: Schema.String, content: Schema.String });

const apiUsers = HttpApiGroup.make("apiUsers")
  .add(
    HttpApiEndpoint.get("me", "/me")
      .addSuccess(Schema.Struct({ user: Schema.NullOr(UserProfile) }))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del("deleteMe", "/me")
      .setUrlParams(Schema.Struct({ token: Schema.optional(Schema.String) }))
      .addSuccess(SuccessResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.patch("patchMe", "/me")
      .setPayload(
        Schema.Struct({
          username: Schema.optional(Schema.String),
          name: Schema.optional(Schema.NullOr(Schema.String)),
          bio: Schema.optional(Schema.String),
          avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )
      .addSuccess(UserProfile)
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("meEmails", "/me/emails")
      .addSuccess(Schema.Array(UserEmailResponse))
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("createMeEmail", "/me/emails")
      .setPayload(Schema.Struct({ email: Schema.String }))
      .addSuccess(UserEmailResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del("deleteMeEmail")`/me/emails/${emailIdPath}`
      .addSuccess(UserEmailResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("meAuthentications", "/me/authentications")
      .addSuccess(Schema.Array(UserAuthenticationResponse))
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del("deleteMeAuthentication")`/me/authentications/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Schema.Struct({ id: Schema.String }))
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("meHasPassword", "/me/has-password")
      .addSuccess(HasPasswordResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("forgotPassword", "/forgotPassword")
      .setPayload(Schema.Struct({ email: Schema.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("resetPassword", "/resetPassword")
      .setPayload(Schema.Struct({ userId: Schema.String, token: Schema.String, password: Schema.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("changePassword", "/changePassword")
      .setPayload(Schema.Struct({ oldPassword: Schema.String, newPassword: Schema.String }))
      .addSuccess(SuccessResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("verifyEmail", "/verifyEmail")
      .setPayload(Schema.Struct({ emailId: Schema.String, token: Schema.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("makeEmailPrimary", "/makeEmailPrimary")
      .setPayload(Schema.Struct({ emailId: Schema.String }))
      .addSuccess(UserEmailResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("resendEmailVerificationCode", "/resendEmailVerificationCode")
      .setPayload(Schema.Struct({ emailId: Schema.String }))
      .addSuccess(SuccessResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");

const apiPlaygrounds = HttpApiGroup.make("apiPlaygrounds")
  .add(
    HttpApiEndpoint.get("userPlaygrounds")`/user/${userPath}`
      .setUrlParams(queryPagination)
      .addSuccess(Schema.Array(PlaygroundListItem))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("playgrounds", "/playgrounds")
      .setUrlParams(queryPagination)
      .addSuccess(Schema.Array(PlaygroundListItemWithUser))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("createPlayground", "/playgrounds")
      .setPayload(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          message: Schema.String,
          description: Schema.optional(Schema.NullOr(Schema.String)),
          files: Schema.Array(PlaygroundFile),
          activeFile: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )
      .addSuccess(CreatePlaygroundResult)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("playgroundByHash")`/playgrounds/${hashPath}`
      .addSuccess(PlaygroundDetail)
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("forkPlayground")`/playgrounds/${hashPath}/fork`
      .setPayload(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) }))
      .addSuccess(ForkPlaygroundResult)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.put("updatePlayground")`/playgrounds/${hashPath}`
      .setPayload(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          description: Schema.optional(Schema.NullOr(Schema.String)),
          privacy: Schema.optional(Privacy),
        }),
      )
      .addSuccess(PlaygroundRow)
      .addError(Unauthorized, { status: 401 })
      .addError(Forbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("createCommit")`/playgrounds/${hashPath}/commits`
      .setPayload(
        Schema.Struct({
          message: Schema.String,
          files: Schema.Array(PlaygroundFile),
          activeFile: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )
      .addSuccess(CreateCommitResult)
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("listCommits")`/playgrounds/${hashPath}/commits`
      .addSuccess(Schema.Array(CommitListItem))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("getCommit")`/playgrounds/${hashPath}/commits/${commitIdPath}`
      .addSuccess(CommitDetail)
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("getCommitHistory")`/playgrounds/${hashPath}/commits/${commitIdPath}/history`
      .setUrlParams(Schema.Struct({ limit: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(CommitHistoryResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("getCommitDiff")`/playgrounds/${hashPath}/commits/${commitIdPath}/diff`
      .addSuccess(CommitDiffResponse)
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("togglePlaygroundStar")`/playgrounds/${hashPath}/star`
      .addSuccess(ToggleStarResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del("deletePlayground")`/playgrounds/${hashPath}`
      .addSuccess(DeletePlaygroundResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(NotFound, { status: 404 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("searchPlaygrounds", "/playgrounds/search")
      .setUrlParams(Schema.Struct({
        q: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.NumberFromString),
        offset: Schema.optional(Schema.NumberFromString),
      }))
      .addSuccess(Schema.Array(PlaygroundListItemWithUser))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");

const systemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("healthz", "/healthz").addSuccess(Schema.Struct({ ok: Schema.Boolean })),
);

const authGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/register")
      .setPayload(Schema.Struct({ username: Schema.String, email: Schema.String, password: Schema.String }))
      .addSuccess(UserProfile)
      .addError(ApiError, { status: 400 })
      .addError(Conflict, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.post("login", "/login")
      .setPayload(Schema.Struct({ id: Schema.String, password: Schema.String }))
      .addSuccess(UserProfile)
      .addError(Unauthorized, { status: 401 })
      .addError(Locked, { status: 423 }),
  )
  .add(HttpApiEndpoint.get("authMe", "/me").addSuccess(Schema.NullOr(SessionUser)))
  .add(
    HttpApiEndpoint.post("logout", "/logout")
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("authGithubStart", "/auth/github")
      .setUrlParams(Schema.Struct({ redirectTo: Schema.optional(Schema.String), mode: Schema.optional(Schema.String) }))
      .addSuccess(Unknown),
  )
  .add(
    HttpApiEndpoint.get("authGithubCallback", "/auth/github/callback")
      .setUrlParams(Schema.Struct({ code: Schema.String, state: Schema.String }))
      .addSuccess(Unknown),
  )
  .middleware(SessionMiddleware);

const webhookGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor").addSuccess(Schema.Unknown))
  .prefix("/webhooks");

class PgGardenApi extends HttpApi.make("PgGardenApi")
  .add(systemGroup)
  .add(authGroup)
  .add(apiUsers)
  .add(apiPlaygrounds)
  .add(webhookGroup) {}

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
          authAttempts.add(1, { method: "password", action: "register", result: "success" });
          authActiveSessions.add(1);
          return setSessionCookie(token, expiresAt);
        }),
        Effect.map((result) => ({ ...datesToUtc(result.user), bio: result.user.bio ?? "" })),
        Effect.catchTags({
          DuplicateAccount: (e) => {
            authAttempts.add(1, { method: "password", action: "register", result: "duplicate" });
            return Effect.fail(new Conflict({ error: e.message }));
          },
          MissingData: (e) => {
            authAttempts.add(1, { method: "password", action: "register", result: "error" });
            return Effect.fail(new ApiError({ error: e.message }));
          },
          WeakPassword: (e) => {
            authAttempts.add(1, { method: "password", action: "register", result: "error" });
            return Effect.fail(new ApiError({ error: e.message }));
          },
        }),
      ),
    )
    .handle("login", ({ payload }) =>
      AuthService.login(payload).pipe(
        Effect.tap(({ token, expiresAt }) => {
          authAttempts.add(1, { method: "password", action: "login", result: "success" });
          authActiveSessions.add(1);
          return setSessionCookie(token, expiresAt);
        }),
        Effect.map((result) => ({ ...datesToUtc(result.user), bio: result.user.bio ?? "" })),
        Effect.catchTags({
          InvalidCredentials: (e) => {
            authAttempts.add(1, { method: "password", action: "login", result: "invalid" });
            return Effect.fail(new Unauthorized({ error: e.message }));
          },
          AccountLocked: (e) => {
            authAttempts.add(1, { method: "password", action: "login", result: "locked" });
            return Effect.fail(new Locked({ error: e.message }));
          },
        }),
      ),
    )
    .handle("authMe", () =>
      CurrentSession.pipe(Effect.map(({ user }) =>
        user ? { ...user, role: user.role as "user" | "sponsor" | "pro" | "admin" } : null,
      )),
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
          return reportHttpError({ route: "logout", status: code, kind: "unknown", error: e }).pipe(
            Effect.zipRight(Effect.fail(httpError)),
          );
        }),
      ),
    )
    .handleRaw("authGithubStart", ({ request }) =>
      Effect.gen(function* () {
        const result = yield* OAuthService.createAuthorizationUrl(["user:email"]);
        const headers: Record<string, string> = {};
        headers["Set-Cookie"] = makeOAuthCookie(STATE_COOKIE, result.state);
        return HttpServerResponse.empty({ status: 302, headers: { Location: result.url.toString(), ...headers } });
      }).pipe(
        Effect.catchAll((e) => {
          if (e instanceof OAuthNotConfiguredError) {
            return Effect.succeed(
              HttpServerResponse.unsafeJson({ error: "GitHub OAuth is not configured" }, { status: 503 }),
            );
          }
          const { code, error } = handleDbError(e, "OAuth error");
          return (code >= 400
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
          return HttpServerResponse.unsafeJson({ error: "Invalid state parameter" }, { status: 400 });
        }

        const { session: currentSession } = yield* CurrentSession;
        const result = yield* OAuthService.handleCallback(urlParams.code, currentSession?.user_id);

        authAttempts.add(1, { method: "github", action: "oauth", result: "success" });
        if (result.isNewSession) {
          authActiveSessions.add(1);
        }

        const authData = JSON.stringify({
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
          if (e instanceof OAuthCallbackError) {
            if (e.isBadCode) {
              authAttempts.add(1, { method: "github", action: "oauth", result: "bad_verification_code" });
              return Effect.succeed(
                HttpServerResponse.unsafeJson({ error: "Bad verification code" }, { status: 400 }),
              );
            }
            authAttempts.add(1, { method: "github", action: "oauth", result: "error" });
            return Effect.succeed(
              HttpServerResponse.unsafeJson({ error: e.message }, { status: 400 }),
            );
          }
          if (e instanceof OAuthNotConfiguredError) {
            return Effect.succeed(
              HttpServerResponse.unsafeJson({ error: "GitHub OAuth is not configured" }, { status: 503 }),
            );
          }
          authAttempts.add(1, { method: "github", action: "oauth", result: "error" });
          const { code, error } = handleDbError(e, "OAuth error");
          return (code >= 400
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
          UserService.getProfile(session.id),
          request.headers,
        );
        return {
          user: profile
            ? { ...profile, role: profile.role as "user" | "sponsor" | "pro" | "admin" }
            : null,
        };
      }),
    )
    .handle("deleteMe", ({ urlParams, request }) =>
      Effect.gen(function* () {
        const { user } = yield* CurrentSession;
        if (!user) return yield* Effect.fail(new Unauthorized({ error: "Unauthorized" }));
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
        const { session } = yield* requireSession("apiUsers.patchMe", request.headers);
        return yield* withDbError(
          "Failed to update profile",
          UserService.updateProfile(session.id, payload).pipe(
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
        const { session } = yield* requireSession("apiUsers.meEmails", request.headers);
        return yield* withDbError("Failed to fetch emails", UserService.listEmails(session.id), request.headers);
      }),
    )
    .handle("createMeEmail", ({ payload, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiUsers.createMeEmail", request.headers);
        return yield* withDbError(
          "Failed to add email",
          UserService.addEmail(session.id, payload.email),
          request.headers,
        );
      }),
    )
    .handle("deleteMeEmail", ({ path, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiUsers.deleteMeEmail", request.headers);
        return yield* withDbError(
          "Failed to delete email",
          UserService.deleteEmail(session.id, path.id).pipe(
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
        const { session } = yield* requireSession("apiUsers.meAuthentications", request.headers);
        return yield* withDbError(
          "Failed to fetch authentications",
          UserService.listAuthentications(session.id),
          request.headers,
        );
      }),
    )
    .handle("deleteMeAuthentication", ({ path, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiUsers.deleteMeAuthentication", request.headers);
        return yield* withDbError(
          "Failed to delete authentication",
          UserService.unlinkAuthentication(session.id, path.id).pipe(
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
        const { session } = yield* requireSession("apiUsers.meHasPassword", request.headers);
        return yield* withDbError(
          "Failed to check password",
          UserService.hasPassword(session.id).pipe(
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
        const { session } = yield* requireSession("apiUsers.changePassword", request.headers);
        return yield* withDbError(
          "Failed to change password",
          UserService.changePassword(session.id, payload.oldPassword, payload.newPassword),
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
        const { session } = yield* requireSession("apiUsers.makeEmailPrimary", request.headers);
        return yield* withDbError(
          "Failed to update primary email",
          UserService.makeEmailPrimary(session.id, payload.emailId),
          request.headers,
        );
      }),
    )
    .handle("resendEmailVerificationCode", ({ payload, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiUsers.resendEmailVerificationCode", request.headers);
        return yield* withDbError(
          "Failed to resend verification",
          UserService.resendEmailVerificationCode(session.id, payload.emailId),
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
      withDbError("Failed to list user playgrounds", Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        return yield* PlaygroundService.listForUser(session?.id, path.username, urlParams);
      }), request.headers),
    )
    .handle("playgrounds", ({ urlParams, request }) =>
      withDbError("Failed to list playgrounds", Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        return yield* PlaygroundService.list(session?.id, urlParams);
      }), request.headers),
    )
    .handle("createPlayground", ({ payload, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiPlaygrounds.createPlayground", request.headers);
        return yield* withDbError(
          "Failed to create playground",
          PlaygroundService.create(session.id, payload).pipe(
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
          const { session } = yield* CurrentSession;
          const pg = yield* PlaygroundService.getByHash(session?.id, path.hash);
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
        const { session } = yield* requireSession("apiPlaygrounds.forkPlayground", request.headers);
        return yield* withDbError(
          "Failed to fork playground",
          PlaygroundService.fork(session.id, path.hash, payload.name).pipe(
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
        const { session, user } = yield* requireSession("apiPlaygrounds.updatePlayground", request.headers);
        if (payload.privacy === "private" && !["sponsor", "pro", "admin"].includes(user.role)) {
          return yield* reportHttpError({
            route: "apiPlaygrounds.updatePlayground",
            status: 403,
            kind: "unknown",
            error: "Private playgrounds require a sponsor account",
            context: requestObservabilityContext(request.headers),
          }).pipe(Effect.zipRight(Effect.fail(new Forbidden({ error: "Private playgrounds require a sponsor account" }))));
        }
        return yield* withDbError(
          "Failed to update playground",
          PlaygroundService.update(session.id, path.hash, payload).pipe(
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
        const { session, user } = yield* requireSession("apiPlaygrounds.createCommit", request.headers);
        return yield* withDbError(
          "Failed to create commit",
          PlaygroundService.createCommit(session.id, user.id, path.hash, payload).pipe(
            Effect.catchTag("NoSuchElementException", () =>
              Effect.fail(new NotFound({ error: "Playground not found" })),
            ),
          ),
          request.headers,
        );
      }),
    )
    .handle("listCommits", ({ path, request }) =>
      withDbError("Failed to fetch playground commits", Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        return yield* PlaygroundService.listCommits(session?.id, path.hash);
      }), request.headers),
    )
    .handle("getCommit", ({ path, request }) =>
      withDbError(
        "Failed to fetch commit",
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          return yield* PlaygroundService.getCommit(session?.id, path.hash, path.commit_id);
        }).pipe(
          Effect.catchTag("NoSuchElementException", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
        request.headers,
      ),
    )
    .handle("getCommitHistory", ({ path, urlParams, request }) =>
      withDbError("Failed to fetch commit history", Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        return yield* PlaygroundService.getCommitHistory(session?.id, path.hash, path.commit_id, urlParams.limit);
      }), request.headers),
    )
    .handle("getCommitDiff", ({ path, request }) =>
      withDbError(
        "Failed to generate diff",
        Effect.gen(function* () {
          const { session } = yield* CurrentSession;
          return yield* PlaygroundService.getCommitDiff(session?.id, path.hash, path.commit_id);
        }).pipe(
          Effect.catchTag("NoSuchElementException", () =>
            Effect.fail(new NotFound({ error: "Commit not found" })),
          ),
        ),
        request.headers,
      ),
    )
    .handle("togglePlaygroundStar", ({ path, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiPlaygrounds.togglePlaygroundStar", request.headers);
        return yield* withDbError(
          "Failed to toggle star",
          PlaygroundService.toggleStar(session.id, path.hash),
          request.headers,
        );
      }),
    )
    .handle("deletePlayground", ({ path, request }) =>
      Effect.gen(function* () {
        const { session } = yield* requireSession("apiPlaygrounds.deletePlayground", request.headers);
        return yield* withDbError(
          "Failed to delete playground",
          PlaygroundService.deletePlayground(session.id, path.hash).pipe(
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
      withDbError("Failed to search playgrounds", Effect.gen(function* () {
        const { session } = yield* CurrentSession;
        return yield* PlaygroundService.search(
          session?.id, urlParams.q ?? "", urlParams.limit, urlParams.offset,
        );
      }), request.headers),
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
      webhookReceived.add(1, { provider: "github", event: event ?? "unknown", verified: "true" });
      return HttpServerResponse.unsafeJson(result);
    }).pipe(
      Effect.catchAll((e) => {
        if (e instanceof WebhookNotConfiguredError) {
          webhookReceived.add(1, { provider: "github", event: event ?? "unknown", verified: "false" });
          return reportHttpError({
            route: "webhooks.githubSponsorWebhook",
            status: 503,
            kind: "webhook",
            error: e,
            context: requestObservabilityContext(request.headers),
          }).pipe(
            Effect.as(HttpServerResponse.unsafeJson({ error: "Webhook not configured" }, { status: 503 })),
          );
        }
        if (e instanceof WebhookVerificationError) {
          webhookReceived.add(1, { provider: "github", event: event ?? "unknown", verified: "false" });
          return reportHttpError({
            route: "webhooks.githubSponsorWebhook",
            status: 401,
            kind: "webhook",
            error: e,
            context: requestObservabilityContext(request.headers),
          }).pipe(
            Effect.as(HttpServerResponse.unsafeJson({ error: "Invalid signature" }, { status: 401 })),
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

export const HttpApiServerLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors()),
  Layer.provide(HttpApiLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: Number(env.PORT) })),
);

const serverProgram = Effect.gen(function* () {
  yield* waitForDependencies.pipe(Effect.provide(Layer.mergeAll(PgRootDB.Live, PgAuthDB.Live)));
  return yield* Layer.launch(HttpApiServerLive);
});

export const runHttpApiServer = () =>
  NodeRuntime.runMain(serverProgram.pipe(Effect.provide(TelemetryLive)));
