import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Array as Arr, Effect, Option, pipe, Schema as S } from "effect";
import * as arctic from "arctic";
import { sql } from "kysely";
import { env } from "../assertEnv.js";
import { PgRootDB } from "../db.js";
import { SessionService } from "./sessionService.js";
import { makeSetCookie } from "./cookies.js";
import { AccountAlreadyLinkedError, unwrapPgError } from "./authService.js";

type UserRole = "user" | "sponsor" | "admin";

const GitHubUserSchema = S.Struct({
  login: S.String,
  email: S.NullishOr(S.String),
  avatar_url: S.NullishOr(S.String),
  name: S.NullishOr(S.String),
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
        collaborators: S.Struct({ totalCount: S.Number }),
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
              monthlyPriceInDollars: S.Number,
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

class OAuthNotConfiguredError extends S.TaggedError<OAuthNotConfiguredError>()("OAuthNotConfigured", {
  message: S.String,
}) { }

class OAuthCallbackError extends S.TaggedError<OAuthCallbackError>()("OAuthCallbackError", {
  message: S.String,
  isBadCode: S.Boolean,
}) { }

const callbackError = (message: string) =>
  Effect.fail(new OAuthCallbackError({ message, isBadCode: false }));

const mapDecodeError = (message: string) =>
  Effect.mapError(() => new OAuthCallbackError({ message, isBadCode: false }));

const fetchGitHubJson = (url: string, token: string, errorPrefix: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return yield* response.json;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((err) =>
      new OAuthCallbackError({
        message: `${errorPrefix}: ${err instanceof Error ? err.message : String(err)}`,
        isBadCode: false,
      })),
  );

export class OAuthService extends Effect.Service<OAuthService>()("OAuthService", {
  effect: Effect.gen(function*() {
    const rootDb = yield* PgRootDB;

    const resolveRole = (login: string): Effect.Effect<Option.Option<UserRole>, never> => {
      if (!env.GITHUB_PAT) {
        return Effect.succeed(Option.none());
      }

      return Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;
        const request = HttpClientRequest.post("https://api.github.com/graphql", {
          headers: { Authorization: `Bearer ${env.GITHUB_PAT}` },
        }).pipe(
          HttpClientRequest.bodyUnsafeJson({
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
        Effect.provide(FetchHttpClient.layer),
        Effect.flatMap((sponsorJson) => S.decodeUnknown(SponsorInfoSchema)(sponsorJson)),
        Effect.flatMap((result) => Effect.succeed(result.data)),
        Effect.map((sponsorInfo) => {
          if (!sponsorInfo) {
            return Option.some("user" as const);
          }
          if (sponsorInfo.user.isViewer) {
            return Option.some("admin" as const);
          }
          if (sponsorInfo.user.isSponsoringViewer || sponsorInfo.repository.collaborators.totalCount > 0) {
            return Option.some("sponsor" as const);
          }
          return Option.some("user" as const);
        }),
        Effect.catchAll(() => Effect.succeed(Option.none())),
      );
    };

    const getProvider = () => {
      if (!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)) {
        return undefined;
      }
      return new arctic.GitHub(
        env.GITHUB_CLIENT_ID,
        env.GITHUB_CLIENT_SECRET,
        `${env.VITE_ROOT_URL}/auth/github/callback`,
      );
    };

    return {
      createAuthorizationUrl: (scopes: string[]) =>
        Effect.gen(function*() {
          const provider = getProvider();
          if (!provider) {
            return yield* Effect.fail(new OAuthNotConfiguredError({
              message: "GitHub OAuth is not configured",
            }));
          }
          const state = arctic.generateState();
          const url = provider.createAuthorizationURL(state, scopes);
          return { url, state };
        }),

      handleCallback: (code: string, currentUserId: string | undefined) =>
        Effect.gen(function*() {
          const provider = getProvider();
          if (!provider) {
            return yield* Effect.fail(new OAuthNotConfiguredError({
              message: "GitHub OAuth is not configured",
            }));
          }

          // 1. Validate authorization code
          const tokens = yield* Effect.tryPromise({
            try: () => provider.validateAuthorizationCode(code),
            catch: (err) =>
              new OAuthCallbackError({
                message: err instanceof Error ? err.message : String(err),
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
          const userInfo = yield* S.decodeUnknown(GitHubUserSchema)(userJson).pipe(
            mapDecodeError("Invalid GitHub user profile response"),
          );

          // 3. Resolve email: prefer public, else fetch from API
          const email: string = yield* (
            userInfo.email
              ? Effect.succeed(userInfo.email)
              : Effect.gen(function*() {
                  const emailsJson: unknown = yield* fetchGitHubJson(
                    "https://api.github.com/user/emails",
                    accessToken,
                    "Failed to fetch GitHub emails",
                  );
                  const emails = yield* S.decodeUnknown(GitHubEmailsSchema)(emailsJson).pipe(
                    mapDecodeError("Invalid GitHub emails response"),
                  );
                  return yield* pipe(
                    Arr.findFirst(emails, (e) => e.primary && e.verified),
                    Option.orElse(() => Arr.findFirst(emails, (e) => e.verified)),
                    Option.map((e) => e.email),
                    Option.match({
                      onNone: () => callbackError(
                        "Could not get email from GitHub. Please make sure you have a verified email on your GitHub account.",
                      ),
                      onSome: Effect.succeed,
                    }),
                  );
                })
          );

          // 4. Resolve role. If sponsor lookup is unavailable, keep existing DB role.
          const resolvedRole: Option.Option<UserRole> = yield* resolveRole(userInfo.login);

          const profile = pipe(
            resolvedRole,
            Option.match({
              onNone: () => ({ ...userInfo, email }),
              onSome: (role) => ({ ...userInfo, email, role }),
            }),
          );

          // 5. Link or register user
          const linkedUser = yield* rootDb
            .selectFrom(
              sql<{ id: string; username: string; role: string }>`app_private.link_or_register_user(
                f_user_id => ${currentUserId ?? null},
                f_service => ${"github"},
                f_identifier => ${userInfo.login},
                f_profile => ${JSON.stringify(profile)}::json,
                f_auth_details => ${JSON.stringify(tokens)}::json
              )`.as("linked_user"),
            )
            .selectAll()
            .pipe(
              Effect.catchAll((e) => {
                const dbErr = unwrapPgError(e);
                const mapped = dbErr?.code === "TAKEN"
                  ? new AccountAlreadyLinkedError({ message: dbErr.message, service: "github" })
                  : undefined;
                return mapped ? Effect.fail(mapped) : Effect.die(e);
              }),
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                callbackError("Failed to link or register user"),
              ),
            );

          const userId = linkedUser.id;
          const username = linkedUser.username || userInfo.login;
          const userRole = linkedUser.role;

          // 6. Create session if no existing session
          const setCookie = currentUserId
            ? undefined
            : yield* SessionService.createSession(userId).pipe(
                Effect.map(({ token, expiresAt }) => makeSetCookie(token, expiresAt)),
              );

          return {
            user: { id: userId, username, role: userRole },
            setCookie,
            isNewSession: !currentUserId,
          };
        }),
    } as const;
  }),
  dependencies: [PgRootDB.Live, SessionService.Default],
  accessors: true,
}) { }

export { OAuthNotConfiguredError, OAuthCallbackError };
