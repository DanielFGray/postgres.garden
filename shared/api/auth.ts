import { Schema as S, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ApiError, Conflict, Locked, ServerError, Unauthorized } from "../errors.js";
import { SuccessResponse, User } from "../schemas.js";
import { SessionMiddleware } from "../session.js";
import { RateLimitMiddleware } from "./rateLimit.js";

const SessionUser = User.mapFields(Struct.pick(["id", "username", "role", "is_verified"]));

/** What GitHub sends the callback: `code` on consent, `error` when the user declines. */
export const GithubCallbackQuery = S.Struct({
  code: S.optional(S.String),
  state: S.String,
  error: S.optional(S.String),
  error_description: S.optional(S.String),
});

export const AuthGroup = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: S.Struct({ username: S.String, email: S.String, password: S.String }),
      success: User,
      error: [ApiError, Conflict],
    }).middleware(RateLimitMiddleware),
  )
  .add(
    HttpApiEndpoint.post("login", "/login", {
      payload: S.Struct({ id: S.String, password: S.String }),
      success: User,
      error: [Unauthorized, Locked],
    }).middleware(RateLimitMiddleware),
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
      query: GithubCallbackQuery,
      success: S.Unknown,
    }),
  )
  .middleware(SessionMiddleware);
