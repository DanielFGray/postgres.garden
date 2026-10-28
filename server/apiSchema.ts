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
import { Context, Schema as S, Struct } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/http-api";
import { Playground, Privacy, User, UserAuthentication, UserEmail } from "./models.js";
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

export class CurrentSession extends Context.Service<CurrentSession, SessionData>()(
  "CurrentSession",
) {}

export class SessionMiddleware extends HttpApiMiddleware.Service<
  SessionMiddleware,
  {
    provides: CurrentSession;
  }
>()("SessionMiddleware", {
  security: { session: sessionCookie },
  error: ServerError,
}) {}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

// -- Derived from the row models in ./models.ts ------------------------------------------

const SessionUser = User.mapFields(Struct.pick(["id", "username", "role", "is_verified"]));

export const UserProfile = User;

const UserEmailResponse = UserEmail;

const UserAuthenticationResponse = UserAuthentication.mapFields(
  Struct.pick(["id", "service", "identifier", "created_at"]),
);

const HasPasswordResponse = S.Struct({ has_password: S.Boolean });

const PlaygroundFile = S.Struct({ path: S.String, content: S.String });

const PlaygroundSummary = Playground.mapFields(
  Struct.pick(["hash", "fork_hash", "name", "description", "created_at", "updated_at"]),
);

export const PlaygroundListItem = S.Struct({
  ...PlaygroundSummary.fields,
  stars: S.BigIntFromString,
});

const PlaygroundListItemWithUser = S.Struct({
  ...PlaygroundSummary.fields,
  stars: S.BigIntFromString,
  user: S.NullOr(S.Struct({ username: S.String })),
});

const PlaygroundDetail = S.Struct({
  ...Playground.mapFields(Struct.omit(["expires_at"])).fields,
  expires_at: S.NullOr(S.DateTimeUtcFromString),
  user: S.NullOr(S.Struct({ username: S.String })),
  stars: S.BigIntFromString,
  is_starred: S.Boolean,
  fork_of: S.NullOr(
    S.Struct({
      hash: S.NullOr(S.String),
      name: S.NullOr(S.String),
      owner: S.NullOr(S.String),
    }),
  ),
});

const PlaygroundRow = Playground;

export const CreatePlaygroundResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtcFromString,
});

const ForkPlaygroundResult = S.Struct({
  commit_id: S.String,
  /** The new playground's hash, which is how the UI opens the fork. */
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtcFromString,
});

export const CreateCommitResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtcFromString,
  forked: S.Boolean,
});

const CommitListItem = S.Struct({
  id: S.String,
  message: S.String,
  timestamp: S.Finite,
  parent_id: S.NullOr(S.String),
  user_id: S.NullOr(S.String),
  username: S.optional(S.String),
});

export const CommitDetail = S.Struct({
  id: S.String,
  message: S.String,
  created_at: S.DateTimeUtcFromString,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  files: S.Array(PlaygroundFile),
  activeFile: S.NullOr(S.String),
  timestamp: S.Finite,
});

export const CommitHistoryItem = S.Struct({
  id: S.String,
  message: S.String,
  timestamp: S.Finite,
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
  offset: S.optional(S.FiniteFromString),
  limit: S.optional(S.FiniteFromString),
  sort: S.optional(
    S.Union([S.Literals(["created_at"]), S.Literals(["updated_at"]), S.Literals(["stars"])]),
  ),
});

const SuccessResponse = S.Struct({ success: S.Boolean });

const apiUsers = HttpApiGroup.make("apiUsers")
  .add(
    HttpApiEndpoint.get("me", "/me", {
      success: S.Struct({ user: S.NullOr(UserProfile) }),
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteMe", "/me", {
      query: S.Struct({ token: S.optional(S.String) }),
      success: SuccessResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.patch("patchMe", "/me", {
      payload: S.Struct({
        username: S.optional(S.String),
        name: S.optional(S.NullOr(S.String)),
        bio: S.optional(S.String),
        avatar_url: S.optional(S.NullOr(S.String)),
      }),
      success: UserProfile,
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("meEmails", "/me/emails", {
      success: S.Array(UserEmailResponse),
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("createMeEmail", "/me/emails", {
      payload: S.Struct({ email: S.String }),
      success: UserEmailResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteMeEmail", "/me/emails/:id", {
      params: { id: S.String },
      success: UserEmailResponse,
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("meAuthentications", "/me/authentications", {
      success: S.Array(UserAuthenticationResponse),
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteMeAuthentication", "/me/authentications/:id", {
      params: { id: S.String },
      success: S.Struct({ id: S.String }),
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("meHasPassword", "/me/has-password", {
      success: HasPasswordResponse,
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("forgotPassword", "/forgotPassword", {
      payload: S.Struct({ email: S.String }),
      success: SuccessResponse,
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resetPassword", "/resetPassword", {
      payload: S.Struct({ userId: S.String, token: S.String, password: S.String }),
      success: SuccessResponse,
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("changePassword", "/changePassword", {
      payload: S.Struct({ oldPassword: S.String, newPassword: S.String }),
      success: SuccessResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("verifyEmail", "/verifyEmail", {
      payload: S.Struct({ emailId: S.String, token: S.String }),
      success: SuccessResponse,
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("makeEmailPrimary", "/makeEmailPrimary", {
      payload: S.Struct({ emailId: S.String }),
      success: UserEmailResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("resendEmailVerificationCode", "/resendEmailVerificationCode", {
      payload: S.Struct({ emailId: S.String }),
      success: SuccessResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");

const apiPlaygrounds = HttpApiGroup.make("apiPlaygrounds")
  .add(
    HttpApiEndpoint.get("userPlaygrounds", "/user/:username", {
      params: { username: S.String },
      query: queryPagination,
      success: S.Array(PlaygroundListItem),
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("playgrounds", "/playgrounds", {
      query: queryPagination,
      success: S.Array(PlaygroundListItemWithUser),
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("createPlayground", "/playgrounds", {
      payload: S.Struct({
        name: S.optional(S.NullOr(S.String)),
        message: S.String,
        description: S.optional(S.NullOr(S.String)),
        files: S.Array(PlaygroundFile),
        activeFile: S.optional(S.NullOr(S.String)),
      }),
      success: CreatePlaygroundResult,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("playgroundByHash", "/playgrounds/:hash", {
      params: { hash: S.String },
      success: PlaygroundDetail,
      error: [NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("forkPlayground", "/playgrounds/:hash/fork", {
      params: { hash: S.String },
      payload: S.Struct({ name: S.optional(S.NullOr(S.String)) }),
      success: ForkPlaygroundResult,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.put("updatePlayground", "/playgrounds/:hash", {
      params: { hash: S.String },
      payload: S.Struct({
        name: S.optional(S.NullOr(S.String)),
        description: S.optional(S.NullOr(S.String)),
        privacy: S.optional(Privacy),
      }),
      success: PlaygroundRow,
      error: [Unauthorized, Forbidden, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("createCommit", "/playgrounds/:hash/commits", {
      params: { hash: S.String },
      payload: S.Struct({
        message: S.String,
        files: S.Array(PlaygroundFile),
        activeFile: S.optional(S.NullOr(S.String)),
      }),
      success: CreateCommitResult,
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("listCommits", "/playgrounds/:hash/commits", {
      params: { hash: S.String },
      success: S.Array(CommitListItem),
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommit", "/playgrounds/:hash/commits/:commit_id", {
      params: { hash: S.String, commit_id: S.String },
      success: CommitDetail,
      error: [NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommitHistory", "/playgrounds/:hash/commits/:commit_id/history", {
      params: { hash: S.String, commit_id: S.String },
      query: S.Struct({ limit: S.optional(S.FiniteFromString) }),
      success: CommitHistoryResponse,
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommitDiff", "/playgrounds/:hash/commits/:commit_id/diff", {
      params: { hash: S.String, commit_id: S.String },
      success: CommitDiffResponse,
      error: [NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("togglePlaygroundStar", "/playgrounds/:hash/star", {
      params: { hash: S.String },
      success: ToggleStarResponse,
      error: [Unauthorized, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deletePlayground", "/playgrounds/:hash", {
      params: { hash: S.String },
      success: DeletePlaygroundResponse,
      error: [Unauthorized, NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("searchPlaygrounds", "/playgrounds/search", {
      query: S.Struct({
        q: S.optional(S.String),
        limit: S.optional(S.FiniteFromString),
        offset: S.optional(S.FiniteFromString),
      }),
      success: S.Array(PlaygroundListItemWithUser),
      error: [ApiError, ServerError],
    }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");

const systemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("healthz", "/healthz", {
    success: S.Struct({ ok: S.Boolean }),
  }),
);

const authGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: S.Struct({ username: S.String, email: S.String, password: S.String }),
      success: UserProfile,
      error: [ApiError, Conflict],
    }),
  )
  .add(
    HttpApiEndpoint.post("login", "/login", {
      payload: S.Struct({ id: S.String, password: S.String }),
      success: UserProfile,
      error: [Unauthorized, Locked],
    }),
  )
  .add(
    HttpApiEndpoint.get("authMe", "/me", {
      success: S.NullOr(SessionUser),
    }),
  )
  .add(
    HttpApiEndpoint.post("logout", "/logout", {
      success: SuccessResponse,
      error: [ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("authGithubStart", "/auth/github", {
      query: S.Struct({ redirectTo: S.optional(S.String), mode: S.optional(S.String) }),
      success: S.Unknown,
    }),
  )
  .add(
    HttpApiEndpoint.get("authGithubCallback", "/auth/github/callback", {
      query: S.Struct({ code: S.String, state: S.String }),
      success: S.Unknown,
    }),
  )
  .middleware(SessionMiddleware);

const webhookGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor", { success: S.Unknown }))
  .prefix("/webhooks");

/**
 * The routes a sandboxed webview may ask the extension host to call for it.
 *
 * The webhook group is left out: GitHub posts to it with a signature and no
 * session, so a webview asking for it is a bug or an attack. The relay refuses
 * anything this list does not match, which is what keeps the contract the only
 * way in. Deriving it from the groups keeps it right when an endpoint is added,
 * and `:param` stands for exactly one path segment.
 */
export const webviewRelayRoutes = [systemGroup, authGroup, apiUsers, apiPlaygrounds].flatMap(
  (group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      method: endpoint.method,
      pattern: new RegExp(
        `^${endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+")}$`,
      ),
    })),
);

export class PgGardenApi extends HttpApi.make("PgGardenApi")
  .add(systemGroup)
  .add(authGroup)
  .add(apiUsers)
  .add(apiPlaygrounds)
  .add(webhookGroup) {}
