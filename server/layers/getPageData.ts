/**
 * Get the initial page data for a request.
 *
 * The client reads the serialized value before mounting Preact.
 */

import { Array as Arr, Effect, Option, pipe } from "effect";
import { parseRoute } from "../../src/shared/routes.js";
import { PlaygroundRepo } from "../../src/shared/services.js";
import { User, type Commit } from "../../src/shared/schemas.js";
import type { PageState } from "../../src/shared/dehydrate.js";
import { CurrentSession } from "../apiSchema.js";
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
 * Get initial page state for a request.
 *
 * Requires the database pools + SessionService in the Effect environment.
 */
export const getPageData = (pathname: string, cookieHeader: string | null) =>
  Effect.gen(function* () {
    // 1. Validate the session; `asVisitor` reads it to scope RLS
    const token = parseSessionToken(cookieHeader);
    const sessionResult = yield* SessionService.validateSessionToken(token);

    // 2. Match the application route
    const route = parseRoute(pathname);

    // 3. Build initial data from the already-validated session and route
    const user = sessionResult.user
      ? new User({
          id: sessionResult.user.id,
          username: sessionResult.user.username,
          role: sessionResult.user.role,
        })
      : null;

    const commit = yield* Effect.gen(function* () {
      let commit: Commit | null = null;
      if (route && (route.type === "playground" || route.type === "commit")) {
        const repo = yield* PlaygroundRepo;
        if (route.type === "commit" && route.commitId && route.playgroundHash) {
          commit = yield* repo.getCommit(route.playgroundHash, route.commitId);
        } else if (route.playgroundHash) {
          commit = yield* repo.getLatestCommit(route.playgroundHash);
        }
      }
      return commit;
    }).pipe(
      Effect.provide(PlaygroundRepoServer),
      Effect.provideService(CurrentSession, sessionResult),
    );

    return { user, commit, route } satisfies PageState;
  }).pipe(
    Effect.orElseSucceed(
      () => ({ user: null, commit: null, route: parseRoute(pathname) }) satisfies PageState,
    ),
  );
