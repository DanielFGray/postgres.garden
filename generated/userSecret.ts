import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UserSecret extends Model.Class<UserSecret>("user_secrets")({
  user_id: S.UUID,
  password_hash: S.NullOr(S.String),
  last_login_at: S.DateFromSelf,
  failed_password_attempts: S.Number,
  first_failed_password_attempt: S.NullOr(S.DateFromSelf),
  reset_password_token: S.NullOr(S.String),
  reset_password_token_generated: S.NullOr(S.DateFromSelf),
  failed_reset_password_attempts: S.Number,
  first_failed_reset_password_attempt: S.NullOr(S.DateFromSelf),
  delete_account_token: S.NullOr(S.String),
  delete_account_token_generated: S.NullOr(S.DateFromSelf),
}) {}
