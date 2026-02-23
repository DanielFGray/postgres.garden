/**
 * Dehydrate / hydrate page data for fibrae SSR.
 *
 * Server: dehydratePageState → __FIBRAE_STATE__ (DehydratedAtom[])
 * Client: hydratePageState  → PageState from that same array
 */

import * as S from "effect/Schema";
import * as Option from "effect/Option";
import { Hydration } from "@effect-atom/atom";
import { User, Commit } from "./schemas.js";
import { RouteInfo } from "./atoms.js";

const encodeUser = S.encodeSync(S.NullOr(User));
const encodeCommit = S.encodeSync(S.Option(Commit));
const encodeRouteInfo = S.encodeSync(S.NullOr(RouteInfo));

const decodeUser = S.decodeUnknownSync(S.NullOr(User));
const decodeCommit = S.decodeUnknownSync(S.Option(Commit));
const decodeRouteInfo = S.decodeUnknownSync(S.NullOr(RouteInfo));

export interface PageState {
  readonly user: User | null;
  readonly commit: Commit | null;
  readonly route: RouteInfo | null;
}

// Matches @effect-atom/atom's internal DehydratedAtomValue shape.
// The public DehydratedAtom type is a narrow marker; hydrate() casts internally.
interface DehydratedAtomValue extends Hydration.DehydratedAtom {
  readonly key: string;
  readonly value: unknown;
  readonly dehydratedAt: number;
}

export function dehydratePageState(
  state: PageState,
): ReadonlyArray<Hydration.DehydratedAtom> {
  const now = Date.now();
  const atoms: DehydratedAtomValue[] = [
    {
      "~@effect-atom/atom/DehydratedAtom": true as const,
      key: "pg/user",
      value: encodeUser(state.user),
      dehydratedAt: now,
    },
    {
      "~@effect-atom/atom/DehydratedAtom": true as const,
      key: "pg/commit",
      value: encodeCommit(
        state.commit ? Option.some(state.commit) : Option.none<Commit>(),
      ),
      dehydratedAt: now,
    },
    {
      "~@effect-atom/atom/DehydratedAtom": true as const,
      key: "pg/route",
      value: encodeRouteInfo(state.route),
      dehydratedAt: now,
    },
  ];
  return atoms as ReadonlyArray<Hydration.DehydratedAtom>;
}

export function hydratePageState(
  state: ReadonlyArray<Hydration.DehydratedAtom>,
): PageState {
  const values = Hydration.toValues(state);
  const find = (key: string) => values.find((v) => v.key === key)?.value;
  const commitOpt = decodeCommit(find("pg/commit") ?? { _tag: "None" });
  return {
    user: decodeUser(find("pg/user") ?? null),
    commit: Option.isSome(commitOpt) ? commitOpt.value : null,
    route: decodeRouteInfo(find("pg/route") ?? null),
  };
}
