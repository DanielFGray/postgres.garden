/**
 * Get page data for a request using fibrae route matching + service layers.
 *
 * Returns dehydrated atoms (DehydratedAtom[]) for injection as __FIBRAE_STATE__.
 * The client's fibrae render() hydrates these atoms directly — no bridge needed.
 */

import { Array as Arr, Effect, Layer, Option, pipe } from "effect";
import type { Hydration } from "@effect-atom/atom";
import { PgRouter } from "../../src/shared/routes.js";
import { PlaygroundRepo, SessionRepo } from "../../src/shared/services.js";
import type { Commit, User } from "../../src/shared/schemas.js";
import { dehydratePageState } from "../../src/shared/dehydrate.js";
import type { RouteInfo } from "../../src/shared/atoms.js";
import { RequestContext } from "./requestContext.js";
import { SessionRepoServer } from "./sessionRepo.js";
import { PlaygroundRepoServer } from "./playgroundRepo.js";
import { SessionService, sessionCookieName } from "../services/sessionService.js";

const parseSessionToken = (cookieHeader: string | null): string | undefined =>
  pipe(
    Option.fromNullable(cookieHeader),
    Option.flatMap((header) =>
      pipe(
        header.split(";"),
        Arr.findFirst((part) => part.trim().split("=")[0] === sessionCookieName),
        Option.map((part) => {
          const [, ...rest] = part.trim().split("=");
          return rest.join("=");
        }),
      ),
    ),
    Option.getOrUndefined,
  );

/**
 * Get dehydrated atom state for a request.
 *
 * Requires PgAuthDB + SessionService in the Effect environment.
 */
export const getPageData = (pathname: string, cookieHeader: string | null) =>
  Effect.gen(function* () {
    // 1. Validate session first to get the session UUID for RLS
    const token = parseSessionToken(cookieHeader);
    const sessionResult = yield* SessionService.validateSessionToken(token);
    const sessionId = sessionResult.session?.id;

    // 2. Match route using fibrae router
    const match = PgRouter.matchRoute(pathname);

    const route: RouteInfo | null = Option.isSome(match)
      ? {
          type: match.value.route.name as "home" | "playground" | "commit" | "shared",
          playgroundHash: (match.value.params as { playgroundId?: string }).playgroundId,
          commitId: (match.value.params as { commitId?: string }).commitId,
        }
      : null;

    // 3. Create per-request service layer with resolved session ID
    const requestLayer = Layer.succeed(RequestContext, {
      cookieHeader,
      sessionId,
    });

    const servicesLayer = Layer.mergeAll(SessionRepoServer, PlaygroundRepoServer).pipe(
      Layer.provide(requestLayer),
    );

    // 4. Run loaders via abstract service interfaces
    const { user, commit } = yield* Effect.gen(function* () {
      const session = yield* SessionRepo;
      const user: User | null = yield* session.getCurrentUser();

      let commit: Commit | null = null;
      if (route && (route.type === "playground" || route.type === "commit")) {
        const repo = yield* PlaygroundRepo;
        if (route.type === "commit" && route.commitId && route.playgroundHash) {
          commit = yield* repo.getCommit(route.playgroundHash, route.commitId);
        } else if (route.playgroundHash) {
          commit = yield* repo.getLatestCommit(route.playgroundHash);
        }
      }

      return { user, commit };
    }).pipe(Effect.provide(servicesLayer));

    return dehydratePageState({ user, commit, route });
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed<ReadonlyArray<Hydration.DehydratedAtom>>([]),
    ),
  );
