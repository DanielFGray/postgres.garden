import * as S from "effect/Schema";
import { SessionUser } from "../../shared/api/auth.js";
import { CommitDetail } from "../../shared/api/playgrounds.js";

export const RouteInfoSchema = S.Struct({
  type: S.Literals(["home", "shared", "playground", "commit", "verify", "reset", "settings"]),
  playgroundHash: S.optional(S.String),
  commitId: S.optional(S.String),
  data: S.optional(S.String),
});

export const PageStateSchema = S.Struct({
  user: S.NullOr(SessionUser),
  commit: S.NullOr(CommitDetail),
  route: S.NullOr(RouteInfoSchema),
});

export type PageState = typeof PageStateSchema.Type;

const emptyPageState: PageState = { user: null, commit: null, route: null };

export const readInitialData = (): PageState => {
  const decoded = S.decodeUnknownExit(PageStateSchema)(window.__INITIAL_DATA__);
  return decoded._tag === "Success" ? decoded.value : emptyPageState;
};

declare global {
  interface Window {
    __INITIAL_DATA__?: unknown;
  }
}
