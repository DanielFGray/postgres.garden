import * as S from "effect/Schema";

export const AccountUserSchema = S.Struct({
  id: S.String,
  username: S.String,
  role: S.String,
  is_verified: S.Boolean,
});

export type AccountUser = typeof AccountUserSchema.Type;

export const AccountMeResponseSchema = S.Struct({
  user: S.NullishOr(AccountUserSchema),
});

export type AccountMeResponse = typeof AccountMeResponseSchema.Type;
