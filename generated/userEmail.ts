import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UserEmailInsert = S.Struct({
  id: S.UUID,
  user_id: S.UUID,
  email: S.String.pipe(S.pattern(/[^@]+@[^@]+\.[^@]+/)),
  is_verified: S.Boolean,
  is_primary: S.Boolean,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserEmailInsertType = S.Schema.Type<typeof UserEmailInsert>;

export const UserEmailUpdate = S.Struct({
  id: S.UUID,
  user_id: S.UUID,
  email: S.String.pipe(S.pattern(/[^@]+@[^@]+\.[^@]+/)),
  is_verified: S.Boolean,
  is_primary: S.Boolean,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserEmailUpdateType = S.Schema.Type<typeof UserEmailUpdate>;

export class UserEmail extends Model.Class<UserEmail>("user_emails")({
  id: Model.Generated(S.UUID),
  user_id: S.UUID,
  email: S.String,
  is_verified: S.Boolean,
  is_primary: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}