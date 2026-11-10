/**
 * Wire shapes for the rows the API returns. Each field mirrors a column in
 * `generated/db.ts`, which kysely-codegen writes from the migrations.
 *
 * Timestamps and bigints travel as strings, the JSON form the API has always
 * sent. The client decodes responses with the same schemas, so both sides agree.
 */
import { Schema as S } from "effect";

const Uuid = S.String.check(S.isUUID());

export const UserRole = S.Literals(["user", "sponsor", "pro", "admin"]);

export const Privacy = S.Literals(["private", "secret", "public"]);

export const User = S.Struct({
  id: Uuid,
  username: S.String,
  name: S.NullOr(S.String),
  avatar_url: S.NullOr(S.String),
  bio: S.String,
  role: UserRole,
  is_verified: S.Boolean,
  created_at: S.DateTimeUtcFromString,
  updated_at: S.DateTimeUtcFromString,
});

export const UserEmail = S.Struct({
  id: Uuid,
  user_id: Uuid,
  email: S.String,
  is_verified: S.Boolean,
  is_primary: S.Boolean,
  created_at: S.DateTimeUtcFromString,
  updated_at: S.DateTimeUtcFromString,
});

// `details` (jsonb) is never sent to a client, so it has no field here.
export const UserAuthentication = S.Struct({
  id: Uuid,
  user_id: Uuid,
  service: S.String,
  identifier: S.String,
  created_at: S.DateTimeUtcFromString,
  updated_at: S.DateTimeUtcFromString,
});

export const Playground = S.Struct({
  hash: S.String,
  /** The playground's newest commit; null until its first one. */
  head_commit_id: S.NullOr(S.String),
  user_id: S.NullOr(Uuid),
  fork_hash: S.NullOr(S.String),
  privacy: Privacy,
  created_at: S.DateTimeUtcFromString,
  updated_at: S.DateTimeUtcFromString,
  name: S.NullOr(S.String),
  description: S.NullOr(S.String),
  data_size: S.BigIntFromString,
  expires_at: S.NullOr(S.DateTimeUtcFromString),
});

/** The answer of an endpoint that reports only that it worked. */
export const SuccessResponse = S.Struct({ success: S.Boolean });
