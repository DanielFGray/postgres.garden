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
import { Playground, Privacy, User, UserAuthentication, UserEmail, UserRole } from "./models.js";
import { ApiError, Conflict, Locked, NotFound, ServerError, Unauthorized } from "./errors.js";

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
 * Session state rehydrated from the Valkey cache. `validateSessionToken`
 * decodes the cached hash against a schema, so a session either carries the
 * fields a user row has or there is no session at all.
 */
export type SessionData = {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: typeof UserRole.Type;
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

/**
 * The header a caller with no account proves a playground is theirs to write to.
 *
 * The key is a credential, not data about the playground, so it travels the way
 * the session cookie does and for the same reason: the client attaches it for
 * whichever playground the page has open, no call site has to remember it, and
 * no endpoint has to declare it. The database decides whether it matches; a
 * handler only reads it off the request and passes it on.
 */
export const EDIT_KEY_HEADER = "x-playground-edit-key";

export const CreatePlaygroundResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateTimeUtcFromString,
  /**
   * The key that holds a playground created without an account, answered once
   * and never stored in a form that could be read back. Null when an account
   * owns the playground, which is reachable through its owner instead.
   */
  edit_key: S.NullOr(S.String),
  /** When an unclaimed playground is pruned. Null once an account owns it. */
  expires_at: S.NullOr(S.DateTimeUtcFromString),
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
  /** `content` is the file in this commit, `parentContent` the file in its parent. */
  modified: S.Array(S.Struct({ ...PlaygroundFile.fields, parentContent: S.String })),
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
        privacy: S.optional(Privacy),
        files: S.Array(PlaygroundFile),
        activeFile: S.optional(S.NullOr(S.String)),
      }),
      success: CreatePlaygroundResult,
      // A caller with no account may start a playground: the answer carries the
      // key that holds it, so there is nothing to be unauthorised for.
      error: [ApiError, ServerError],
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
      // An account is one way to hold a playground and the key is the other,
      // so this takes no session of its own: a caller with neither matches no
      // row and is told the playground is not there.
      error: [NotFound, ApiError, ServerError],
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
      error: [NotFound, ApiError, ServerError],
    }),
  )
  .add(
    HttpApiEndpoint.post("claimPlayground", "/playgrounds/:hash/claim", {
      params: { hash: S.String },
      success: PlaygroundRow,
      error: [Unauthorized, ApiError, ServerError],
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

/** The health contract's 200 body. Shared with the platform: its keys are fixed. */
const HealthOk = S.Struct({ status: S.Literal("ok"), commit: S.String });

/**
 * The health contract's 503 body. `failed` names dependencies only; the
 * platform reads this route without authentication, so error text stays in the logs.
 */
class HealthUnavailable extends S.Class<HealthUnavailable, { readonly brand: unique symbol }>(
  "HealthUnavailable",
)(
  {
    status: S.Literal("error"),
    commit: S.String,
    failed: S.Array(S.String),
  },
  { httpApiStatus: 503 },
) {}

const systemGroup = HttpApiGroup.make("system").add(
  // The deploy platform health-checks this route, so it answers 503 when a
  // dependency is down: an instance that cannot reach Postgres should be taken
  // out of rotation, not kept in it because the process is still running.
  HttpApiEndpoint.get("healthz", "/healthz", {
    success: HealthOk,
    error: [HealthUnavailable],
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
      success: S.Unknown,
    }),
  )
  .add(
    // GitHub answers a declined consent screen with `error` and no `code`, so
    // both are optional and the handler decides which pair it got. A required
    // `code` would turn pressing Cancel into a schema error in the popup, with
    // nothing to tell the tab that opened it.
    HttpApiEndpoint.get("authGithubCallback", "/auth/github/callback", {
      query: S.Struct({
        code: S.optional(S.String),
        state: S.String,
        error: S.optional(S.String),
        error_description: S.optional(S.String),
      }),
      success: S.Unknown,
    }),
  )
  .middleware(SessionMiddleware);

const webhookGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor", { success: S.Unknown }))
  .prefix("/webhooks");

/**
 * The method and path of every endpoint in `groups`, as a matchable pattern.
 * `:param` stands for exactly one path segment, and the group's own prefix is
 * already part of `endpoint.path`.
 */
const groupRoutes = <
  G extends {
    readonly endpoints: Record<string, { readonly method: string; readonly path: string }>;
  },
>(
  groups: ReadonlyArray<G>,
) =>
  groups.flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => ({
      method: endpoint.method,
      pattern: new RegExp(
        `^${endpoint.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+")}$`,
      ),
    })),
  );

/**
 * The routes a sandboxed webview may ask the extension host to call for it.
 *
 * The webhook group is left out: GitHub posts to it with a signature and no
 * session, so a webview asking for it is a bug or an attack. The relay refuses
 * anything this list does not match, which is what keeps the contract the only
 * way in.
 */
export const webviewRelayRoutes = groupRoutes([
  systemGroup,
  authGroup,
  apiUsers,
  apiPlaygrounds,
]);

const allRoutes = groupRoutes([systemGroup, authGroup, apiUsers, apiPlaygrounds, webhookGroup]);

/**
 * Whether the server answers `pathname` from the API rather than from the page
 * renderer.
 *
 * The auth group has no prefix, so `/register`, `/login`, `/me` and `/logout`
 * sit beside the page routes and only the contract can tell them apart. Asking
 * the contract means an endpoint added to a group is served the moment it is
 * declared; a hand-kept list would answer the new path with the page shell and
 * a 200, which fails nowhere.
 *
 * Everything under `/api` counts even with no endpoint to match, so a mistyped
 * API path gets the API's own 404 instead of a page.
 */
export const isApiPath = (pathname: string): boolean =>
  pathname === "/api" ||
  pathname.startsWith("/api/") ||
  allRoutes.some((route) => route.pattern.test(pathname));

export class PgGardenApi extends HttpApi.make("PgGardenApi")
  .add(systemGroup)
  .add(authGroup)
  .add(apiUsers)
  .add(apiPlaygrounds)
  .add(webhookGroup) {}
