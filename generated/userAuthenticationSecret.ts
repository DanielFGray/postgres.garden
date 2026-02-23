import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const UserAuthenticationSecretInsert = S.Struct({
  user_authentication_id: S.UUID,
  details: S.Unknown,
});

export type UserAuthenticationSecretInsertType = S.Schema.Type<typeof UserAuthenticationSecretInsert>;

export const UserAuthenticationSecretUpdate = S.Struct({
  user_authentication_id: S.UUID,
  details: S.Unknown,
});

export type UserAuthenticationSecretUpdateType = S.Schema.Type<typeof UserAuthenticationSecretUpdate>;

export class UserAuthenticationSecret extends Model.Class<UserAuthenticationSecret>("user_authentication_secrets")({
  user_authentication_id: S.UUID,
  details: S.Unknown,
}) {}