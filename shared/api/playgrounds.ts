import { Schema as S, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { NotFound, Unauthorized } from "../errors.js";
import { Playground, Privacy } from "../schemas.js";
import { SessionMiddleware } from "../session.js";

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
  expires_at: S.NullOr(S.DateFromString),
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
  created_at: S.DateFromString,
  /**
   * The key that holds a playground created without an account, answered once
   * and never stored in a form that could be read back. Null when an account
   * owns the playground, which is reachable through its owner instead.
   */
  edit_key: S.NullOr(S.String),
  /** When an unclaimed playground is pruned. Null once an account owns it. */
  expires_at: S.NullOr(S.DateFromString),
});

const ForkPlaygroundResult = S.Struct({
  commit_id: S.String,
  /** The new playground's hash, which is how the UI opens the fork. */
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateFromString,
});

export const CreateCommitResult = S.Struct({
  commit_id: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  message: S.String,
  created_at: S.DateFromString,
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
  created_at: S.DateFromString,
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

const queryPagination = S.Struct({
  offset: S.optional(S.FiniteFromString),
  limit: S.optional(S.FiniteFromString),
  sort: S.optional(
    S.Union([S.Literals(["created_at"]), S.Literals(["updated_at"]), S.Literals(["stars"])]),
  ),
});

export const PlaygroundsGroup = HttpApiGroup.make("apiPlaygrounds")
  .add(
    HttpApiEndpoint.get("userPlaygrounds", "/user/:username", {
      params: { username: S.String },
      query: queryPagination,
      success: S.Array(PlaygroundListItem),
    }),
  )
  .add(
    HttpApiEndpoint.get("playgrounds", "/playgrounds", {
      query: queryPagination,
      success: S.Array(PlaygroundListItemWithUser),
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
    }),
  )
  .add(
    HttpApiEndpoint.get("playgroundByHash", "/playgrounds/:hash", {
      params: { hash: S.String },
      success: PlaygroundDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("forkPlayground", "/playgrounds/:hash/fork", {
      params: { hash: S.String },
      payload: S.Struct({ name: S.optional(S.NullOr(S.String)) }),
      success: ForkPlaygroundResult,
      error: Unauthorized,
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
      error: NotFound,
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
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("claimPlayground", "/playgrounds/:hash/claim", {
      params: { hash: S.String },
      success: PlaygroundRow,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.get("listCommits", "/playgrounds/:hash/commits", {
      params: { hash: S.String },
      success: S.Array(CommitListItem),
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommit", "/playgrounds/:hash/commits/:commit_id", {
      params: { hash: S.String, commit_id: S.String },
      success: CommitDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommitHistory", "/playgrounds/:hash/commits/:commit_id/history", {
      params: { hash: S.String, commit_id: S.String },
      query: S.Struct({ limit: S.optional(S.FiniteFromString) }),
      success: CommitHistoryResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("getCommitDiff", "/playgrounds/:hash/commits/:commit_id/diff", {
      params: { hash: S.String, commit_id: S.String },
      success: CommitDiffResponse,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("togglePlaygroundStar", "/playgrounds/:hash/star", {
      params: { hash: S.String },
      success: ToggleStarResponse,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deletePlayground", "/playgrounds/:hash", {
      params: { hash: S.String },
      success: DeletePlaygroundResponse,
      error: [Unauthorized, NotFound],
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
    }),
  )
  .middleware(SessionMiddleware)
  .prefix("/api");
