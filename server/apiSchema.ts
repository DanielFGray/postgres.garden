/**
 * The single definition of the pg.garden HTTP API.
 *
 * Both sides derive from this: the server implements it in `apiHandlers.ts`,
 * and the browser builds its client from it in `src/httpapi-client.ts`. Keeping
 * one definition is what makes a changed path or payload a type error on both
 * sides instead of a silent 404.
 *
 * This module must stay free of server-only imports (db, env, services) so the
 * browser can import it. `SessionMiddleware` is declared here as a bare tag;
 * its implementation lives in `services/sessionMiddleware.ts`.
 */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform";
import { Context, Schema as S } from "effect";
import { User } from "../generated/user.js";
import { Playground } from "../generated/playground.js";
import { UserEmail } from "../generated/userEmail.js";
import { UserAuthentication } from "../generated/userAuthentication.js";
import { Privacy } from "../generated/privacy.js";
import {
  ApiError,
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  ServerError,
  Unauthorized,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Session security
// ---------------------------------------------------------------------------

export const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "session" });

export type SessionInfo = {
  readonly id: string;
  readonly cookie_id: string;
  readonly user_id: string;
  readonly expires_at: Date;
};

/**
 * Session state rehydrated from the Valkey cache. `role` is a plain string
 * rather than `UserRole` because the cache stores unparsed strings and
 * `validateSessionToken` defaults absent roles to "visitor", which is not a
 * member of the `UserRole` union.
 */
export type SessionData = {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: string;
    readonly is_verified: boolean;
  } | null;
  readonly session: SessionInfo | null;
};

export class CurrentSession extends Context.Tag("CurrentSession")<CurrentSession, SessionData>() {}

export class SessionMiddleware extends HttpApiMiddleware.Tag<SessionMiddleware>()(
  "SessionMiddleware",
  {
    provides: CurrentSession,
    security: { session: sessionCookie },
  },
) {}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

// -- Derived from generated models ------------------------------------------

const SessionUser = User.json.pipe(S.pick("id", "username", "role", "is_verified"));

export const UserProfile = User.json;

const UserEmailResponse = UserEmail.json;

const UserAuthenticationResponse = UserAuthentication.json.pipe(
  S.pick("id", "service", "identifier", "created_at"),
);

const HasPasswordResponse = S.Struct({ has_password: S.Boolean });

const PlaygroundFile = S.Struct({ path: S.String, content: S.String });

export const PlaygroundListItem = Playground.json.pipe(
  S.pick("hash", "fork_hash", "name", "description", "created_at", "updated_at"),
  S.extend(S.Struct({ stars: S.BigInt })),
);

const PlaygroundListItemWithUser = Playground.json.pipe(
  S.pick("hash", "fork_hash", "name", "description", "created_at", "updated_at"),
  S.extend(
    S.Struct({
      stars: S.BigInt,
      user: S.NullOr(S.Struct({ username: S.String })),
    }),
  ),
);

const PlaygroundDetail = Playground.json.pipe(
  S.omit("expires_at"),
  S.extend(
    S.Struct({
      expires_at: S.NullOr(S.DateTimeUtc),
      user: S.NullOr(S.Struct({ username: S.String })),
      stars: S.BigInt,
      is_starred: S.Boolean,
      fork_of: S.NullOr(
        S.Struct({
          hash: S.NullOr(S.String),
          name: S.NullOr(S.String),
          owner: S.NullOr(S.String),
        }),
      ),
    }),
  ),
);

const PlaygroundRow = Playground.json.pipe(
  S.omit("expires_at"),
  S.extend(S.Struct({ expires_at: S.NullOr(S.DateTimeUtc) })),
);

export const CreatePlaygroundResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtc,
});

const ForkPlaygroundResult = S.Struct({
  commit_id: S.String,
  playground_id: S.Number,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtc,
});

export const CreateCommitResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtc,
  forked: S.Boolean,
});

const CommitListItem = S.Struct({
  id: S.String,
  message: S.String,
  timestamp: S.Number,
  parent_id: S.NullOr(S.String),
  user_id: S.NullOr(S.String),
  username: S.optional(S.String),
});

export const CommitDetail = S.Struct({
  id: S.String,
  message: S.String,
  created_at: S.DateTimeUtc,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  files: S.Array(PlaygroundFile),
  activeFile: S.NullOr(S.String),
  timestamp: S.Number,
});

export const CommitHistoryItem = S.Struct({
  id: S.String,
  message: S.String,
  timestamp: S.Number,
  parent_id: S.NullOr(S.String),
  playground_hash: S.String,
});

const CommitHistoryResponse = S.Struct({
  history: S.Array(CommitHistoryItem),
  isComplete: S.Boolean,
});

const CommitDiffResponse = S.Struct({
  isRootCommit: S.Boolean,
  added: S.Array(PlaygroundFile),
  modified: S.Array(PlaygroundFile),
  deleted: S.Array(PlaygroundFile),
});

const ToggleStarResponse = S.Struct({ starred: S.Boolean });

const DeletePlaygroundResponse = S.Struct({ hash: S.String });

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------
const queryPagination = S.Struct({
  offset: S.optional(S.NumberFromString),
  limit: S.optional(S.NumberFromString),
  sort: S.optional(S.Union(S.Literal("created_at"), S.Literal("updated_at"), S.Literal("stars"))),
});

const userPath = HttpApiSchema.param("username", S.String);
const hashPath = HttpApiSchema.param("hash", S.String);
const emailIdPath = HttpApiSchema.param("id", S.String);
const commitIdPath = HttpApiSchema.param("commit_id", S.String);
const SuccessResponse = S.Struct({ success: S.Boolean });
const apiUsers = HttpApiGroup.make("apiUsers")
  .add(
    HttpApiEndpoint.get("me", "/me")
      .addSuccess(S.Struct({ user: S.NullOr(UserProfile) }))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del("deleteMe", "/me")
      .setUrlParams(S.Struct({ token: S.optional(S.String) }))
      .addSuccess(SuccessResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.patch("patchMe", "/me")
      .setPayload(
        S.Struct({
          username: S.optional(S.String),
          name: S.optional(S.NullOr(S.String)),
          bio: S.optional(S.String),
          avatar_url: S.optional(S.NullOr(S.String)),
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
      .addSuccess(S.Array(UserEmailResponse))
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("createMeEmail", "/me/emails")
      .setPayload(S.Struct({ email: S.String }))
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
      .addSuccess(S.Array(UserAuthenticationResponse))
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.del(
      "deleteMeAuthentication",
    )`/me/authentications/${HttpApiSchema.param("id", S.String)}`
      .addSuccess(S.Struct({ id: S.String }))
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
      .setPayload(S.Struct({ email: S.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("resetPassword", "/resetPassword")
      .setPayload(S.Struct({ userId: S.String, token: S.String, password: S.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("changePassword", "/changePassword")
      .setPayload(S.Struct({ oldPassword: S.String, newPassword: S.String }))
      .addSuccess(SuccessResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("verifyEmail", "/verifyEmail")
      .setPayload(S.Struct({ emailId: S.String, token: S.String }))
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("makeEmailPrimary", "/makeEmailPrimary")
      .setPayload(S.Struct({ emailId: S.String }))
      .addSuccess(UserEmailResponse)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("resendEmailVerificationCode", "/resendEmailVerificationCode")
      .setPayload(S.Struct({ emailId: S.String }))
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
      .addSuccess(S.Array(PlaygroundListItem))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("playgrounds", "/playgrounds")
      .setUrlParams(queryPagination)
      .addSuccess(S.Array(PlaygroundListItemWithUser))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.post("createPlayground", "/playgrounds")
      .setPayload(
        S.Struct({
          name: S.optional(S.NullOr(S.String)),
          message: S.String,
          description: S.optional(S.NullOr(S.String)),
          files: S.Array(PlaygroundFile),
          activeFile: S.optional(S.NullOr(S.String)),
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
      .setPayload(S.Struct({ name: S.optional(S.NullOr(S.String)) }))
      .addSuccess(ForkPlaygroundResult)
      .addError(Unauthorized, { status: 401 })
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.put("updatePlayground")`/playgrounds/${hashPath}`
      .setPayload(
        S.Struct({
          name: S.optional(S.NullOr(S.String)),
          description: S.optional(S.NullOr(S.String)),
          privacy: S.optional(Privacy),
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
        S.Struct({
          message: S.String,
          files: S.Array(PlaygroundFile),
          activeFile: S.optional(S.NullOr(S.String)),
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
      .addSuccess(S.Array(CommitListItem))
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
    HttpApiEndpoint.get(
      "getCommitHistory",
    )`/playgrounds/${hashPath}/commits/${commitIdPath}/history`
      .setUrlParams(S.Struct({ limit: S.optional(S.NumberFromString) }))
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
      .setUrlParams(
        S.Struct({
          q: S.optional(S.String),
          limit: S.optional(S.NumberFromString),
          offset: S.optional(S.NumberFromString),
        }),
      )
      .addSuccess(S.Array(PlaygroundListItemWithUser))
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");

const systemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("healthz", "/healthz").addSuccess(S.Struct({ ok: S.Boolean })),
);

const authGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/register")
      .setPayload(S.Struct({ username: S.String, email: S.String, password: S.String }))
      .addSuccess(UserProfile)
      .addError(ApiError, { status: 400 })
      .addError(Conflict, { status: 409 }),
  )
  .add(
    HttpApiEndpoint.post("login", "/login")
      .setPayload(S.Struct({ id: S.String, password: S.String }))
      .addSuccess(UserProfile)
      .addError(Unauthorized, { status: 401 })
      .addError(Locked, { status: 423 }),
  )
  .add(HttpApiEndpoint.get("authMe", "/me").addSuccess(S.NullOr(SessionUser)))
  .add(
    HttpApiEndpoint.post("logout", "/logout")
      .addSuccess(SuccessResponse)
      .addError(ApiError, { status: 400 })
      .addError(ServerError, { status: 500 }),
  )
  .add(
    HttpApiEndpoint.get("authGithubStart", "/auth/github")
      .setUrlParams(S.Struct({ redirectTo: S.optional(S.String), mode: S.optional(S.String) }))
      .addSuccess(S.Unknown),
  )
  .add(
    HttpApiEndpoint.get("authGithubCallback", "/auth/github/callback")
      .setUrlParams(S.Struct({ code: S.String, state: S.String }))
      .addSuccess(S.Unknown),
  )
  .middleware(SessionMiddleware);
const webhookGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor").addSuccess(S.Unknown))
  .prefix("/webhooks");

export class PgGardenApi extends HttpApi.make("PgGardenApi")
  .add(systemGroup)
  .add(authGroup)
  .add(apiUsers)
  .add(apiPlaygrounds)
  .add(webhookGroup) {}
