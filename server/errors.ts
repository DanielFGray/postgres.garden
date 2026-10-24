import { Schema as S } from "effect";

// ---------------------------------------------------------------------------
// HTTP error types. Each class's `httpApiStatus` annotation sets the status
// that HttpApi encodes when an endpoint fails with it.
// ---------------------------------------------------------------------------
export class ApiError extends S.TaggedError<ApiError>()(
  "ApiError",
  { error: S.String },
  { httpApiStatus: 400 },
) {}
export class Unauthorized extends S.TaggedError<Unauthorized>()(
  "Unauthorized",
  { error: S.String },
  { httpApiStatus: 401 },
) {}
export class Forbidden extends S.TaggedError<Forbidden>()(
  "Forbidden",
  { error: S.String },
  { httpApiStatus: 403 },
) {}
export class NotFound extends S.TaggedError<NotFound>()(
  "NotFound",
  { error: S.String },
  { httpApiStatus: 404 },
) {}
export class Conflict extends S.TaggedError<Conflict>()(
  "Conflict",
  { error: S.String },
  { httpApiStatus: 409 },
) {}
export class Locked extends S.TaggedError<Locked>()(
  "Locked",
  { error: S.String },
  { httpApiStatus: 423 },
) {}
export class ServerError extends S.TaggedError<ServerError>()(
  "ServerError",
  { error: S.String },
  { httpApiStatus: 500 },
) {}
