import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class Session extends Model.Class<Session>("sessions")({
  id: S.String,
  user_id: S.UUID,
  session_data: S.Unknown,
  secret_hash: S.NullOr(S.Unknown),
  created_at: Model.DateTimeInsertFromDate,
  expires_at: S.NullOr(S.DateFromSelf),
}) {}
