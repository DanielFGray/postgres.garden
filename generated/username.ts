import { Schema as S } from "effect";

export const Username = S.String.pipe(S.minLength(2), S.maxLength(64), S.pattern(/^[a-zA-Z][a-zA-Z0-9_-]+$/));

export type UsernameType = S.Schema.Type<typeof Username>;