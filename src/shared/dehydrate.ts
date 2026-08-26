import * as S from "effect/Schema";
import { Commit, User } from "./schemas.js";

export const RouteInfoSchema = S.Struct({
  type: S.Literal("home", "shared", "playground", "commit", "verify", "reset", "settings"),
  playgroundHash: S.optional(S.String),
  commitId: S.optional(S.String),
  data: S.optional(S.String),
});

export const PageStateSchema = S.Struct({
  user: S.NullOr(User),
  commit: S.NullOr(Commit),
  route: S.NullOr(RouteInfoSchema),
});

export type PageState = typeof PageStateSchema.Type;

const emptyPageState: PageState = { user: null, commit: null, route: null };

export const readInitialData = (): PageState => {
  const decoded = S.decodeUnknownEither(PageStateSchema)(window.__INITIAL_DATA__);
  return decoded._tag === "Right" ? decoded.right : emptyPageState;
};

declare global {
  interface Window {
    __INITIAL_DATA__?: unknown;
  }
}
