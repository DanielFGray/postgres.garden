import { Schema as S } from "effect";

export const Privacy = S.Union(S.Literal("private"), S.Literal("secret"), S.Literal("public"));

export type PrivacyType = S.Schema.Type<typeof Privacy>;