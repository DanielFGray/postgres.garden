import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UserEmailSecretInsert = S.Struct({
  user_email_id: S.UUID,
  verification_token: S.String.pipe(S.NullOr),
  verification_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
  password_reset_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
});

export type UserEmailSecretInsertType = S.Schema.Type<typeof UserEmailSecretInsert>;

export const UserEmailSecretUpdate = S.Struct({
  user_email_id: S.UUID,
  verification_token: S.String.pipe(S.NullOr),
  verification_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
  password_reset_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
});

export type UserEmailSecretUpdateType = S.Schema.Type<typeof UserEmailSecretUpdate>;

export class UserEmailSecret extends Model.Class<UserEmailSecret>("user_email_secrets")({
  user_email_id: S.UUID,
  verification_token: S.String.pipe(S.NullOr),
  verification_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
  password_reset_email_sent_at: S.DateFromSelf.pipe(S.NullOr),
}) {}