import { Schema as S } from "effect";

export const Url = S.String.pipe(S.pattern(/^https?:\/\/\S+$/));

export type UrlType = S.Schema.Type<typeof Url>;