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
