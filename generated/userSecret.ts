import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UserSecretInsert = S.Struct({
  user_id: S.UUID,
  password_hash: S.String.pipe(S.NullOr),
  last_login_at: S.DateFromSelf,
  failed_password_attempts: S.Number,
  first_failed_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  reset_password_token: S.String.pipe(S.NullOr),
  reset_password_token_generated: S.DateFromSelf.pipe(S.NullOr),
  failed_reset_password_attempts: S.Number,
  first_failed_reset_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  delete_account_token: S.String.pipe(S.NullOr),
  delete_account_token_generated: S.DateFromSelf.pipe(S.NullOr),
});

export type UserSecretInsertType = S.Schema.Type<typeof UserSecretInsert>;

export const UserSecretUpdate = S.Struct({
  user_id: S.UUID,
  password_hash: S.String.pipe(S.NullOr),
  last_login_at: S.DateFromSelf,
  failed_password_attempts: S.Number,
  first_failed_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  reset_password_token: S.String.pipe(S.NullOr),
  reset_password_token_generated: S.DateFromSelf.pipe(S.NullOr),
  failed_reset_password_attempts: S.Number,
  first_failed_reset_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  delete_account_token: S.String.pipe(S.NullOr),
  delete_account_token_generated: S.DateFromSelf.pipe(S.NullOr),
});

export type UserSecretUpdateType = S.Schema.Type<typeof UserSecretUpdate>;

export class UserSecret extends Model.Class<UserSecret>("user_secrets")({
  user_id: S.UUID,
  password_hash: S.String.pipe(S.NullOr),
  last_login_at: S.DateFromSelf,
  failed_password_attempts: S.Number,
  first_failed_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  reset_password_token: S.String.pipe(S.NullOr),
  reset_password_token_generated: S.DateFromSelf.pipe(S.NullOr),
  failed_reset_password_attempts: S.Number,
  first_failed_reset_password_attempt: S.DateFromSelf.pipe(S.NullOr),
  delete_account_token: S.String.pipe(S.NullOr),
  delete_account_token_generated: S.DateFromSelf.pipe(S.NullOr),
}) {}