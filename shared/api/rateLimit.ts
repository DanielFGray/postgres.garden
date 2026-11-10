import { HttpApiMiddleware } from "effect/http-api";
import { TooManyRequests } from "../errors.js";
import { CurrentSession } from "../session.js";

/**
 * Per-caller limits on the endpoints that send email, check a secret or cost a
 * password hash. The server applies a rule keyed by `group:endpoint`; an
 * endpoint without this middleware has no limit. It requires `CurrentSession`,
 * so the group's `SessionMiddleware` runs first and a per-user rule can key on
 * the signed-in user.
 */
export class RateLimitMiddleware extends HttpApiMiddleware.Service<
  RateLimitMiddleware,
  { requires: CurrentSession }
>()("RateLimitMiddleware", {
  error: TooManyRequests,
}) {}
