import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UserEmailSecret extends Model.Class<UserEmailSecret>("user_email_secrets")({
  user_email_id: S.UUID,
  verification_token: S.NullOr(S.String),
  verification_email_sent_at: S.NullOr(S.DateFromSelf),
  password_reset_email_sent_at: S.NullOr(S.DateFromSelf),
}) {}
