import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UserAuthentication extends Model.Class<UserAuthentication>("user_authentications")({
  id: Model.Generated(S.UUID),
  user_id: S.UUID,
  service: S.String,
  identifier: S.String,
  details: S.Unknown,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
