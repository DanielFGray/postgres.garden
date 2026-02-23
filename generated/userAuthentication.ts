import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UserAuthenticationInsert = S.Struct({
  id: S.UUID,
  user_id: S.UUID,
  service: S.String,
  identifier: S.String,
  details: S.Unknown,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserAuthenticationInsertType = S.Schema.Type<typeof UserAuthenticationInsert>;

export const UserAuthenticationUpdate = S.Struct({
  id: S.UUID,
  user_id: S.UUID,
  service: S.String,
  identifier: S.String,
  details: S.Unknown,
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type UserAuthenticationUpdateType = S.Schema.Type<typeof UserAuthenticationUpdate>;

export class UserAuthentication extends Model.Class<UserAuthentication>("user_authentications")({
  id: Model.Generated(S.UUID),
  user_id: S.UUID,
  service: S.String,
  identifier: S.String,
  details: S.Unknown,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}