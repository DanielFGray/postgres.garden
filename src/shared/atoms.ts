/**
 * Serializable atoms for postgres.garden
 *
 * Replace window.__INITIAL_DATA__ with fibrae-compatible serializable atoms.
 * These are dehydrated during SSR and hydrated on the client via __FIBRAE_STATE__.
 */

import * as S from "effect/Schema";
import * as Option from "effect/Option";
import { Atom } from "@effect-atom/atom";
import { User, Commit } from "./schemas.js";

// =============================================================================
// UserAtom — current authenticated user (null = not logged in)
// =============================================================================

export const UserAtom = Atom.make<User | null>(null).pipe(
  Atom.serializable({
    key: "pg/user",
    schema: S.NullOr(User),
  }),
);

// =============================================================================
// CommitAtom — current commit data (None = no commit loaded yet)
// =============================================================================

export const CommitAtom = Atom.make<Option.Option<Commit>>(Option.none()).pipe(
  Atom.serializable({
    key: "pg/commit",
    schema: S.Option(Commit),
  }),
);

// =============================================================================
// RouteInfoAtom — current route metadata
// =============================================================================

export const RouteInfo = S.Struct({
  type: S.Literal("home", "playground", "commit", "shared"),
  playgroundHash: S.optional(S.String),
  commitId: S.optional(S.String),
});

export type RouteInfo = typeof RouteInfo.Type;

export const RouteInfoAtom = Atom.make<RouteInfo | null>(null).pipe(
  Atom.serializable({
    key: "pg/route",
    schema: S.NullOr(RouteInfo),
  }),
);
