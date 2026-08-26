import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class UserAuthenticationSecret extends Model.Class<UserAuthenticationSecret>(
  "user_authentication_secrets",
)({
  user_authentication_id: S.UUID,
  details: S.Unknown,
}) {}
