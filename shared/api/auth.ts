import { Schema as S } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Unauthorized } from "../errors.js";
import { SuccessResponse, User } from "../schemas.js";
import { SessionMiddleware } from "../session.js";
import { RateLimitMiddleware } from "./rateLimit.js";

/** What GitHub sends the callback: `code` on consent, `error` when the user declines. */
export const GithubCallbackQuery = S.Struct({
  code: S.optional(S.String),
  state: S.String,
  error: S.optional(S.String),
  error_description: S.optional(S.String),
});

export const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/api/auth/register", {
      payload: S.Struct({ username: S.String, email: S.String, password: S.String }),
      success: User,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("login", "/api/auth/login", {
      payload: S.Struct({ id: S.String, password: S.String }),
      success: User,
      error: Unauthorized,
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("logout", "/api/auth/logout", {
      success: SuccessResponse,
    }),
  )
  // The GitHub routes stay at the site root: the callback URL is registered on
  // the GitHub OAuth app, and the start route sits beside it.
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
      query: GithubCallbackQuery,
      success: S.Unknown,
    }),
  )
  .middleware(SessionMiddleware);
