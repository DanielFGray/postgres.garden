import { Schema as S } from "effect";
import { Model } from "@effect/sql";
import { Username } from "./username.js";
import { Url } from "./url.js";
import { UserRole } from "./userRole.js";

export const UserInsert = S.Struct({
  id: S.UUID,
  username: Username,
  name: S.String.pipe(S.NullOr),
  avatar_url: Url.pipe(S.NullOr, S.optional),
  bio: S.String.pipe(S.maxLength(2000)),
  role: UserRole.pipe(S.optional),
  is_verified: S.Boolean,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserInsertType = S.Schema.Type<typeof UserInsert>;

export const UserUpdate = S.Struct({
  id: S.UUID,
  username: Username.pipe(S.optional),
  name: S.String.pipe(S.NullOr),
  avatar_url: Url.pipe(S.NullOr, S.optional),
  bio: S.String.pipe(S.maxLength(2000)),
  role: UserRole.pipe(S.optional),
  is_verified: S.Boolean,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserUpdateType = S.Schema.Type<typeof UserUpdate>;

export class User extends Model.Class<User>("users")({
  id: Model.Generated(S.UUID),
  username: Username,
  name: S.String.pipe(S.NullOr),
  avatar_url: Url.pipe(S.NullOr),
  bio: S.String,
  role: UserRole,
  is_verified: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}