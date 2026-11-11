import { Schema as S } from "effect";

/**
 * Broad HTTP errors. Each class owns one status via `httpApiStatus`; variants
 * that share a status are told apart by a typed `reason` literal. Every body
 * has `_tag` and `message`, and `message` is written for users.
 */

/**
 * A failure that no handler mapped (a defect). It carries a fixed message and
 * the request's trace id, so a user report can be matched to the logged cause.
 */
export class InternalError extends S.TaggedError<
  InternalError,
  { readonly brand: unique symbol }
>()(
  "InternalError",
  {
    message: S.String,
    /** Finds the request in the traces and logs. */
    traceId: S.String,
  },
  { httpApiStatus: 500 },
) {}

export class Unauthorized extends S.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  {
    message: S.String,
    reason: S.Literals(["authentication_required", "invalid_credentials"]),
  },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends S.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  "Forbidden",
  {
    message: S.String,
    reason: S.Literals(["access_denied"]),
  },
  { httpApiStatus: 403 },
) {}

export class NotFound extends S.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  { message: S.String },
  { httpApiStatus: 404 },
) {}

export class Conflict extends S.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  "Conflict",
  {
    message: S.String,
    reason: S.Literals([
      "username_taken",
      "email_taken",
      "already_member",
      "account_already_linked",
      "owns_organization",
      "slug_taken",
      "already_exists",
      "related_data",
    ]),
  },
  { httpApiStatus: 409 },
) {}

export class Locked extends S.TaggedError<Locked, { readonly brand: unique symbol }>()(
  "Locked",
  { message: S.String },
  { httpApiStatus: 423 },
) {}

/** The caller went over a rate limit, or the limit store is down on an endpoint that refuses then. */
export class TooManyRequests extends S.TaggedError<
  TooManyRequests,
  { readonly brand: unique symbol }
>()("TooManyRequests", { message: S.String, retryAfterSeconds: S.Int }, { httpApiStatus: 429 }) {}

/**
 * One rejected request value. `path` starts with the request part (`payload`,
 * `params`, `query`, `headers`); `message` is the field schema's own text,
 * which never quotes the value back.
 */
export const InputIssue = S.Struct({
  path: S.Array(S.Union([S.String, S.Int])),
  message: S.String,
});

export class InvalidOperation extends S.TaggedError<
  InvalidOperation,
  { readonly brand: unique symbol }
>()(
  "InvalidOperation",
  {
    message: S.String,
    reason: S.Literals([
      "cannot_delete_last_email",
      "email_not_verified",
      "weak_password",
      "missing_data",
      "invalid_input",
    ]),
    /** For `invalid_input`: each value the request schema rejected. */
    issues: S.optional(S.Array(InputIssue)),
  },
  { httpApiStatus: 400 },
) {}

/**
 * The database could not finish the request now: a conflict with a concurrent
 * transaction (`busy`) or a statement timeout (`timed_out`). The same request
 * may succeed if the client sends it again.
 */
export class ServiceUnavailable extends S.TaggedError<
  ServiceUnavailable,
  { readonly brand: unique symbol }
>()(
  "ServiceUnavailable",
  {
    message: S.String,
    reason: S.Literals(["busy", "timed_out"]),
  },
  { httpApiStatus: 503 },
) {}

/**
 * Every class a refused database call can be answered with (see
 * server/databaseErrors.ts). Any endpoint that queries can answer any of them.
 */
export const DatabaseRefusals = [
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  Locked,
  InvalidOperation,
  ServiceUnavailable,
] as const;
export type DatabaseRefusal = (typeof DatabaseRefusals)[number]["Type"];
