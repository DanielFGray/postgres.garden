import { Schema as S } from "effect";

export const UserRole = S.Union(
  S.Literal("user"),
  S.Literal("sponsor"),
  S.Literal("pro"),
  S.Literal("admin"),
);
