import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UnregisteredEmailPasswordResetInsert = S.Struct({
  email: S.String,
  attempts: S.Number,
  latest_attempt: S.DateFromSelf,
});

export type UnregisteredEmailPasswordResetInsertType = S.Schema.Type<typeof UnregisteredEmailPasswordResetInsert>;

export const UnregisteredEmailPasswordResetUpdate = S.Struct({
  email: S.String,
  attempts: S.Number,
  latest_attempt: S.DateFromSelf,
});

export type UnregisteredEmailPasswordResetUpdateType = S.Schema.Type<typeof UnregisteredEmailPasswordResetUpdate>;

export class UnregisteredEmailPasswordReset extends Model.Class<UnregisteredEmailPasswordReset>("unregistered_email_password_resets")({
  email: S.String,
  attempts: S.Number,
  latest_attempt: S.DateFromSelf,
}) {}