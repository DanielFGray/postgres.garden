import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UserEmail extends Model.Class<UserEmail>("user_emails")({
  id: Model.Generated(S.UUID),
  user_id: S.UUID,
  email: S.String,
  is_verified: S.Boolean,
  is_primary: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
