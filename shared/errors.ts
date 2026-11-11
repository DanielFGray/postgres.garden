import { Schema as S } from "effect";

// ---------------------------------------------------------------------------
// HTTP error types. Each class's `httpApiStatus` annotation sets the status
// that HttpApi encodes when an endpoint fails with it.
// ---------------------------------------------------------------------------
export class ApiError extends S.TaggedError<ApiError, { readonly brand: unique symbol }>()(
  "ApiError",
  { error: S.String },
  { httpApiStatus: 400 },
) {}
export class Unauthorized extends S.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  { error: S.String },
  { httpApiStatus: 401 },
) {}
export class NotFound extends S.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  "NotFound",
  { error: S.String },
  { httpApiStatus: 404 },
) {}
export class Conflict extends S.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  "Conflict",
  { error: S.String },
  { httpApiStatus: 409 },
) {}
export class Locked extends S.TaggedError<Locked, { readonly brand: unique symbol }>()(
  "Locked",
  { error: S.String },
  { httpApiStatus: 423 },
) {}
export class ServerError extends S.TaggedError<ServerError, { readonly brand: unique symbol }>()(
  "ServerError",
  { error: S.String },
  { httpApiStatus: 500 },
) {}
/** The caller went over a rate limit, or the limit store is down on an endpoint that refuses then. */
export class TooManyRequests extends S.TaggedError<
  TooManyRequests,
  { readonly brand: unique symbol }
>()("TooManyRequests", { error: S.String, retryAfterSeconds: S.Int }, { httpApiStatus: 429 }) {}

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
    reason: S.Literals(["invalid_input"]),
    /** For `invalid_input`: each value the request schema rejected. */
    issues: S.optional(S.Array(InputIssue)),
  },
  { httpApiStatus: 400 },
) {}
