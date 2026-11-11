import { HttpClient, HttpClientRequest } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  Array as Arr,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Redacted,
  Schema as S,
} from "effect";
import * as arctic from "arctic";
import { sql } from "kysely";
import { rootUrl } from "../config.js";
import { PgRootDB } from "../db.js";
import { SessionService } from "./sessionService.js";
import { Cookies } from "./cookies.js";
import { UserRole as UserRoleSchema } from "../../shared/schemas.js";

type UserRole = "user" | "sponsor" | "admin";

const GitHubUserSchema = S.Struct({
  login: S.String,
  email: S.NullishOr(S.String),
  avatar_url: S.NullishOr(S.String),
  name: S.NullishOr(S.String),
});

/** What link_or_register_user stores as the GitHub profile of the account. */
const LinkedProfile = S.Struct({
  ...GitHubUserSchema.fields,
  email: S.String,
  role: S.optional(UserRoleSchema),
});

/**
 * GitHub's token response, as arctic holds it, stored as the authentication's
 * details. Only `access_token` is required: `tokens.accessToken()` has already
 * read it, and the other fields depend on the app's token settings.
 */
const GitHubTokens = S.Struct({
  data: S.Struct({
    access_token: S.String,
    token_type: S.optional(S.String),
    scope: S.optional(S.String),
    expires_in: S.optional(S.Finite),
    refresh_token: S.optional(S.String),
    refresh_token_expires_in: S.optional(S.Finite),
  }),
});

const GitHubEmailsSchema = S.Array(
  S.Struct({
    email: S.String,
    primary: S.Boolean,
    verified: S.Boolean,
  }),
);

const SponsorInfoSchema = S.Struct({
  data: S.NullOr(
    S.Struct({
      repository: S.Struct({
        collaborators: S.Struct({ totalCount: S.Finite }),
      }),
      user: S.Struct({
        isSponsoringViewer: S.Boolean,
        isViewer: S.Boolean,
        sponsorshipForViewerAsSponsorable: S.NullOr(
          S.Struct({
            isActive: S.Boolean,
            isOneTimePayment: S.Boolean,
            tier: S.Struct({
              name: S.String,
              monthlyPriceInDollars: S.Finite,
            }),
          }),
        ),
      }),
    }),
  ),
});

const sponsorQuery = `
  query ($user: String!, $repo: String!, $owner: String!) {
    repository(owner: $owner, name: $repo) {
      collaborators(query: $user) {
        totalCount
      }
    }
    user(login: $user) {
      isSponsoringViewer
      isViewer
      sponsorshipForViewerAsSponsorable {
        isActive
        isOneTimePayment
        tier {
          name
          monthlyPriceInDollars
        }
      }
    }
  }
`;

class OAuthNotConfiguredError extends S.TaggedError<
  OAuthNotConfiguredError,
  { readonly brand: unique symbol }
>()("OAuthNotConfigured", {
  message: S.String,
}) {}

class OAuthCallbackError extends S.TaggedError<
  OAuthCallbackError,
  { readonly brand: unique symbol }
>()("OAuthCallbackError", {
  /** Shown to the user in the popup, so it never carries GitHub's or the client's own text. */
  message: S.String,
  isBadCode: S.Boolean,
  /** What went wrong underneath, for the log only. */
  cause: S.optional(S.Unknown),
}) {}

const callbackError = (message: string) =>
  Effect.fail(new OAuthCallbackError({ message, isBadCode: false }));

const mapDecodeError = (message: string) =>
  Effect.mapError(() => new OAuthCallbackError({ message, isBadCode: false }));

export class OAuthService extends Context.Service<OAuthService>()("OAuthService", {
  make: Effect.gen(function* () {
    const githubPat = Option.getOrUndefined(yield* Config.option(Config.Redacted("GITHUB_PAT")));
    const clientId = Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_CLIENT_ID")));
    const clientSecret = Option.getOrUndefined(
      yield* Config.option(Config.Redacted("GITHUB_CLIENT_SECRET")),
    );
    const callbackUrl = `${yield* rootUrl}/auth/github/callback`;
    const cookies = yield* Cookies;
    const root = yield* PgRootDB;
    const sessions = yield* SessionService;
    const client = yield* HttpClient.HttpClient;

    const fetchGitHubJson = (url: string, token: string, errorPrefix: string) =>
      client.get(url, { headers: { Authorization: `Bearer ${token}` } }).pipe(
        Effect.flatMap((response) => response.json),
        Effect.mapError(
          (cause) => new OAuthCallbackError({ message: errorPrefix, isBadCode: false, cause }),
        ),
      );

    const resolveRole = (login: string): Effect.Effect<Option.Option<UserRole>, never> => {
      if (!githubPat) {
        return Effect.succeedNone;
      }

      return Effect.gen(function* () {
        const request = HttpClientRequest.post("https://api.github.com/graphql", {
          headers: { Authorization: `Bearer ${Redacted.value(githubPat)}` },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query: sponsorQuery,
            variables: {
              user: login,
              owner: "danielfgray",
              repo: "postgres-playground",
            },
          }),
        );

        const response = yield* client.execute(request);
        return yield* response.json;
      }).pipe(
        Effect.flatMap((sponsorJson) => S.decodeUnknownEffect(SponsorInfoSchema)(sponsorJson)),
        Effect.map((result) => result.data),
        Effect.map((sponsorInfo) => {
          if (!sponsorInfo) {
            return Option.some("user" as const);
          }
          if (sponsorInfo.user.isViewer) {
            return Option.some("admin" as const);
          }
          if (
            sponsorInfo.user.isSponsoringViewer ||
            sponsorInfo.repository.collaborators.totalCount > 0
          ) {
            return Option.some("sponsor" as const);
          }
          return Option.some("user" as const);
        }),
        Effect.orElseSucceed(() => Option.none()),
      );
    };

    const getProvider = () => {
      if (!(clientId && clientSecret)) {
        return undefined;
      }
      return new arctic.GitHub(clientId, Redacted.value(clientSecret), callbackUrl);
    };

    return {
      createAuthorizationUrl: Effect.fn("OAuthService.createAuthorizationUrl")((scopes: string[]) =>
        Effect.gen(function* () {
          const provider = getProvider();
          if (!provider) {
            return yield* new OAuthNotConfiguredError({
              message: "GitHub OAuth is not configured",
            });
          }
          const state = arctic.generateState();
          const url = provider.createAuthorizationURL(state, scopes);
          return { url, state };
        }),
      ),

      handleCallback: Effect.fn("OAuthService.handleCallback")(
        (code: string, currentUserId: string | undefined) =>
          Effect.gen(function* () {
            const provider = getProvider();
            if (!provider) {
              return yield* new OAuthNotConfiguredError({
                message: "GitHub OAuth is not configured",
              });
            }

            // 1. Validate authorization code
            const tokens = yield* Effect.tryPromise({
              try: () => provider.validateAuthorizationCode(code),
              catch: (err) =>
                new OAuthCallbackError({
                  message: "GitHub could not confirm this sign-in.",
                  cause: err,
                  isBadCode:
                    err instanceof arctic.OAuth2RequestError &&
                    err.message === "bad_verification_code",
                }),
            });
            const accessToken = tokens.accessToken();

            // 2. Fetch user profile
            const userJson: unknown = yield* fetchGitHubJson(
              "https://api.github.com/user",
              accessToken,
              "Failed to fetch GitHub user",
            );
            const userInfo = yield* S.decodeUnknownEffect(GitHubUserSchema)(userJson).pipe(
              mapDecodeError("Invalid GitHub user profile response"),
            );

            // 3. Resolve email: prefer public, else fetch from API
            const email: string = yield* userInfo.email
              ? Effect.succeed(userInfo.email)
              : Effect.gen(function* () {
                  const emailsJson: unknown = yield* fetchGitHubJson(
                    "https://api.github.com/user/emails",
                    accessToken,
                    "Failed to fetch GitHub emails",
                  );
                  const emails = yield* S.decodeUnknownEffect(GitHubEmailsSchema)(emailsJson).pipe(
                    mapDecodeError("Invalid GitHub emails response"),
                  );
                  return yield* pipe(
                    Arr.findFirst(emails, (e) => e.primary && e.verified),
                    Option.orElse(() => Arr.findFirst(emails, (e) => e.verified)),
                    Option.map((e) => e.email),
                    Option.match({
                      onNone: () =>
                        callbackError(
                          "Could not get email from GitHub. Please make sure you have a verified email on your GitHub account.",
                        ),
                      onSome: Effect.succeed,
                    }),
                  );
                });

            // 4. Resolve role. If sponsor lookup is unavailable, keep existing DB role.
            const resolvedRole: Option.Option<UserRole> = yield* resolveRole(userInfo.login);

            const profile = pipe(
              resolvedRole,
              Option.match({
                onNone: () => ({ ...userInfo, email }),
                onSome: (role) => ({ ...userInfo, email, role }),
              }),
            );

            const profileJson = yield* S.encodeEffect(S.fromJsonString(LinkedProfile))(
              profile,
            ).pipe(Effect.orDie);
            const tokensJson = yield* S.decodeUnknownEffect(GitHubTokens)(tokens).pipe(
              mapDecodeError("Invalid GitHub token response"),
              Effect.flatMap((decoded) =>
                S.encodeEffect(S.fromJsonString(GitHubTokens))(decoded).pipe(Effect.orDie),
              ),
            );

            // 5. Link or register user
            const linkedUser = yield* root
              .all(
                root.connection
                  .selectFrom(
                    sql<{
                      id: string;
                      username: string;
                      role: string;
                    }>`app_private.link_or_register_user(
          f_user_id => ${currentUserId ?? null},
          f_service => ${"github"},
          f_identifier => ${userInfo.login},
          f_profile => ${profileJson}::json,
          f_auth_details => ${tokensJson}::json
                        )`.as("linked_user"),
                  )
                  .selectAll(),
              )
              .pipe(
                Effect.head,
                Effect.catchTag("NoSuchElementError", () =>
                  callbackError("Failed to link or register user"),
                ),
              );

            const userId = linkedUser.id;
            const username = linkedUser.username || userInfo.login;
            const userRole = linkedUser.role;

            // 6. Create session if no existing session
            const setCookie = currentUserId
              ? undefined
              : yield* sessions.createSession(userId).pipe(
                  Effect.map(({ token, expiresAt }) => cookies.sessionHeader(token, expiresAt)),
                  // The user row was just written and Valkey holds the session: either
                  // failing leaves nothing the popup can tell the user to fix.
                  Effect.catchTags({ NoSuchElementError: Effect.die, RedisError: Effect.die }),
                );

            return {
              user: { id: userId, username, role: userRole },
              setCookie,
              isNewSession: !currentUserId,
            };
          }),
      ),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(SessionService.layer, Cookies.layer, FetchHttpClient.layer)),
  );
}

export { OAuthNotConfiguredError, OAuthCallbackError };
