import { Schema as S } from "effect";

// ---------------------------------------------------------------------------
// HTTP error types — used with addError() so the platform encodes responses
// ---------------------------------------------------------------------------
export class ApiError extends S.TaggedError<ApiError>()("ApiError", {
  error: S.String,
}) {
  static readonly status = 400 as const;
}
export class Unauthorized extends S.TaggedError<Unauthorized>()("Unauthorized", {
  error: S.String,
}) {
  static readonly status = 401 as const;
}
export class Forbidden extends S.TaggedError<Forbidden>()("Forbidden", {
  error: S.String,
}) {
  static readonly status = 403 as const;
}
export class NotFound extends S.TaggedError<NotFound>()("NotFound", {
  error: S.String,
}) {
  static readonly status = 404 as const;
}
export class Conflict extends S.TaggedError<Conflict>()("Conflict", {
  error: S.String,
}) {
  static readonly status = 409 as const;
}
export class Locked extends S.TaggedError<Locked>()("Locked", {
  error: S.String,
}) {
  static readonly status = 423 as const;
}
export class ServerError extends S.TaggedError<ServerError>()("ServerError", {
  error: S.String,
}) {
  static readonly status = 500 as const;
}
