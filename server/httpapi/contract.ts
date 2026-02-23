import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema as S } from "effect";
import { User } from "../../generated/user.js";
import { Playground } from "../../generated/playground.js";
import { UserEmail } from "../../generated/userEmail.js";
import { UserAuthentication } from "../../generated/userAuthentication.js";
import { Privacy } from "../../generated/privacy.js";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const SuccessResponse = S.Struct({ success: S.Boolean });

// -- Derived from generated models ------------------------------------------

export const SessionUser = User.json.pipe(S.pick("id", "username", "role", "is_verified"));

export const UserProfile = User.json;

export const UserEmailResponse = UserEmail.json;

export const UserAuthenticationResponse = UserAuthentication.json.pipe(
  S.pick("id", "service", "identifier", "created_at"),
);

export const HasPasswordResponse = S.Struct({ has_password: S.Boolean });

export const PlaygroundFile = S.Struct({ path: S.String, content: S.String });

export const PlaygroundListItem = Playground.json.pipe(
  S.pick("hash", "fork_hash", "name", "description", "created_at", "updated_at"),
  S.extend(S.Struct({ stars: S.String })),
);

export const PlaygroundListItemWithUser = Playground.json.pipe(
  S.pick("hash", "fork_hash", "name", "description", "created_at", "updated_at"),
  S.extend(S.Struct({
    stars: S.String,
    user: S.Struct({ username: S.String }),
  })),
);

export const PlaygroundDetail = Playground.json.pipe(
  S.omit("expires_at"),
  S.extend(S.Struct({
    expires_at: S.NullOr(S.DateTimeUtc),
    user: S.NullOr(S.Struct({ username: S.String })),
    stars: S.String,
    is_starred: S.Boolean,
    fork_of: S.NullOr(
      S.Struct({
        hash: S.NullOr(S.String),
        name: S.NullOr(S.String),
        owner: S.NullOr(S.String),
      }),
    ),
  })),
);

export const PlaygroundRow = Playground.json.pipe(
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

export const ForkPlaygroundResult = S.Struct({
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

export const CommitListItem = S.Struct({
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

export const CommitHistoryResponse = S.Struct({
  history: S.Array(CommitHistoryItem),
  isComplete: S.Boolean,
});

export const CommitDiffResponse = S.Struct({
  isRootCommit: S.Boolean,
  added: S.Array(PlaygroundFile),
  modified: S.Array(PlaygroundFile),
  deleted: S.Array(PlaygroundFile),
});

export const ToggleStarResponse = S.Struct({ starred: S.Boolean });

export const DeletePlaygroundResponse = S.Struct({ hash: S.String });

// ---------------------------------------------------------------------------
// Query / path schemas
// ---------------------------------------------------------------------------

const PaginationQuery = S.Struct({
  offset: S.optional(S.NumberFromString),
  limit: S.optional(S.NumberFromString),
  sort: S.optional(S.Union(S.Literal("created_at"), S.Literal("updated_at"), S.Literal("stars"))),
});

const meResponse = S.Struct({ user: S.NullOr(SessionUser) });
const usernamePath = S.Struct({ username: S.String });
const hashPath = S.Struct({ hash: S.String });
const commitPath = S.Struct({ hash: S.String, commit_id: S.String });

// ---------------------------------------------------------------------------
// API groups
// ---------------------------------------------------------------------------

const ApiUsersGroup = HttpApiGroup.make("apiUsers")
  .add(HttpApiEndpoint.post("apiLogout", "/logout").addSuccess(SuccessResponse))
  .add(HttpApiEndpoint.get("apiMe", "/me").addSuccess(meResponse))
  .add(
    HttpApiEndpoint.del("apiDeleteMe", "/me")
      .setUrlParams(S.Struct({ token: S.optional(S.String) }))
      .addSuccess(SuccessResponse),
  )
  .add(
    HttpApiEndpoint.patch("apiPatchMe", "/me")
      .setPayload(
        S.Struct({
          name: S.optional(S.NullOr(S.String)),
          bio: S.optional(S.String),
          avatar_url: S.optional(S.NullOr(S.String)),
        }),
      )
      .addSuccess(UserProfile),
  )
  .add(HttpApiEndpoint.get("apiMeEmails", "/me/emails").addSuccess(S.Array(UserEmailResponse)))
  .add(
    HttpApiEndpoint.post("apiCreateMeEmail", "/me/emails")
      .setPayload(S.Struct({ email: S.String }))
      .addSuccess(UserEmailResponse),
  )
  .add(
    HttpApiEndpoint.del(
      "apiDeleteMeEmail",
    )`/me/emails/${HttpApiSchema.param("id", S.String)}`.addSuccess(UserEmailResponse),
  )
  .add(
    HttpApiEndpoint.get("apiMeAuthentications", "/me/authentications").addSuccess(
      S.Array(UserAuthenticationResponse),
    ),
  )
  .add(
    HttpApiEndpoint.del(
      "apiDeleteMeAuthentication",
    )`/me/authentications/${HttpApiSchema.param("id", S.String)}`.addSuccess(
      S.Struct({ id: S.String }),
    ),
  )
  .add(HttpApiEndpoint.get("apiMeHasPassword", "/me/has-password").addSuccess(HasPasswordResponse))
  .add(
    HttpApiEndpoint.post("apiForgotPassword", "/forgotPassword")
      .setPayload(S.Struct({ email: S.String }))
      .addSuccess(SuccessResponse),
  )
  .add(
    HttpApiEndpoint.post("apiResetPassword", "/resetPassword")
      .setPayload(
        S.Struct({
          userId: S.String,
          token: S.String,
          password: S.String,
        }),
      )
      .addSuccess(SuccessResponse),
  )
  .add(
    HttpApiEndpoint.post("apiChangePassword", "/changePassword")
      .setPayload(S.Struct({ oldPassword: S.String, newPassword: S.String }))
      .addSuccess(SuccessResponse),
  )
  .add(
    HttpApiEndpoint.post("apiVerifyEmail", "/verifyEmail")
      .setPayload(S.Struct({ emailId: S.String, token: S.String }))
      .addSuccess(SuccessResponse),
  )
  .add(
    HttpApiEndpoint.post("apiMakeEmailPrimary", "/makeEmailPrimary")
      .setPayload(S.Struct({ emailId: S.String }))
      .addSuccess(UserEmailResponse),
  )
  .add(
    HttpApiEndpoint.post("apiResendEmailVerificationCode", "/resendEmailVerificationCode")
      .setPayload(S.Struct({ emailId: S.String }))
      .addSuccess(SuccessResponse),
  )
  .prefix("/api");

const ApiPlaygroundsGroup = HttpApiGroup.make("apiPlaygrounds")
  .add(
    HttpApiEndpoint.get("apiGetUserPlaygrounds", "/user/:username")
      .setPath(usernamePath)
      .setUrlParams(PaginationQuery)
      .addSuccess(S.Array(PlaygroundListItem)),
  )
  .add(
    HttpApiEndpoint.get("apiListPlaygrounds", "/playgrounds")
      .setUrlParams(PaginationQuery)
      .addSuccess(S.Array(PlaygroundListItemWithUser)),
  )
  .add(
    HttpApiEndpoint.post("apiCreatePlayground", "/playgrounds")
      .setPayload(
        S.Struct({
          name: S.optional(S.NullOr(S.String)),
          message: S.String,
          description: S.optional(S.NullOr(S.String)),
          files: S.Array(PlaygroundFile),
          activeFile: S.optional(S.NullOr(S.String)),
        }),
      )
      .addSuccess(CreatePlaygroundResult),
  )
  .add(
    HttpApiEndpoint.get(
      "apiGetPlayground",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}`.addSuccess(PlaygroundDetail),
  )
  .add(
    HttpApiEndpoint.post(
      "apiForkPlayground",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/fork`
      .setPayload(S.Struct({ name: S.optional(S.NullOr(S.String)) }))
      .addSuccess(ForkPlaygroundResult),
  )
  .add(
    HttpApiEndpoint.put(
      "apiUpdatePlayground",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}`
      .setPayload(
        S.Struct({
          name: S.optional(S.NullOr(S.String)),
          description: S.optional(S.NullOr(S.String)),
          privacy: S.optional(Privacy),
        }),
      )
      .addSuccess(PlaygroundRow),
  )
  .add(
    HttpApiEndpoint.post(
      "apiCreatePlaygroundCommit",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/commits`
      .setPayload(
        S.Struct({
          message: S.String,
          files: S.Array(PlaygroundFile),
          activeFile: S.optional(S.NullOr(S.String)),
        }),
      )
      .addSuccess(CreateCommitResult),
  )
  .add(
    HttpApiEndpoint.get(
      "apiListPlaygroundCommits",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/commits`.addSuccess(
      S.Array(CommitListItem),
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "apiGetPlaygroundCommit",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/commits/${HttpApiSchema.param("commit_id", S.String)}`.addSuccess(
      CommitDetail,
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "apiGetPlaygroundCommitHistory",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/commits/${HttpApiSchema.param("commit_id", S.String)}/history`
      .setUrlParams(S.Struct({ limit: S.optional(S.NumberFromString) }))
      .addSuccess(CommitHistoryResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "apiGetPlaygroundCommitDiff",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/commits/${HttpApiSchema.param("commit_id", S.String)}/diff`.addSuccess(
      CommitDiffResponse,
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "apiTogglePlaygroundStar",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}/star`.addSuccess(ToggleStarResponse),
  )
  .add(
    HttpApiEndpoint.del(
      "apiDeletePlayground",
    )`/playgrounds/${HttpApiSchema.param("hash", S.String)}`.addSuccess(DeletePlaygroundResponse),
  )
  .add(
    HttpApiEndpoint.get("apiSearchPlaygrounds", "/playgrounds/search")
      .setUrlParams(
        S.Struct({
          q: S.optional(S.String),
          limit: S.optional(S.NumberFromString),
          offset: S.optional(S.NumberFromString),
        }),
      )
      .addSuccess(S.Array(PlaygroundListItemWithUser)),
  )
  .prefix("/api");

const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("authRegister", "/register")
      .setPayload(
        S.Struct({
          username: S.String,
          email: S.String,
          password: S.String,
        }),
      )
      .addSuccess(UserProfile),
  )
  .add(
    HttpApiEndpoint.post("authLogin", "/login")
      .setPayload(S.Struct({ id: S.String, password: S.String }))
      .addSuccess(UserProfile),
  )
  .add(HttpApiEndpoint.get("authMe", "/me").addSuccess(S.NullOr(SessionUser)))
  .add(HttpApiEndpoint.post("authLogout", "/logout").addSuccess(SuccessResponse))
  .add(
    HttpApiEndpoint.get("authGithubStart", "/auth/github")
      .setUrlParams(S.Struct({ redirectTo: S.optional(S.String) }))
      .addSuccess(S.Unknown),
  )
  .add(
    HttpApiEndpoint.get("authGithubCallback", "/auth/github/callback")
      .setUrlParams(
        S.Struct({
          code: S.String,
          state: S.String,
          redirectTo: S.optional(S.String),
        }),
      )
      .addSuccess(S.Unknown),
  );

const WebhooksGroup = HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("githubSponsorWebhook", "/gh_sponsor").addSuccess(S.Unknown))
  .prefix("/webhooks");

const SystemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("healthz", "/healthz").addSuccess(S.Struct({ ok: S.Boolean })),
);

export class PgGardenContract extends HttpApi.make("PgGardenContract")
  .add(ApiUsersGroup)
  .add(ApiPlaygroundsGroup)
  .add(AuthGroup)
  .add(WebhooksGroup)
  .add(SystemGroup) { }

export const ContractPathSchemas = {
  usernamePath,
  hashPath,
  commitPath,
} as const;
