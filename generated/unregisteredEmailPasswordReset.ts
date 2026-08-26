import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UnregisteredEmailPasswordReset extends Model.Class<UnregisteredEmailPasswordReset>(
  "unregistered_email_password_resets",
)({
  email: S.String,
  attempts: S.Number,
  latest_attempt: S.DateFromSelf,
}) {}
