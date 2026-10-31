/**
 * Get the initial page data for a request.
 *
 * The client reads the serialized value before the workbench boots.
 */

import { Array as Arr, Cause, Effect, Option, pipe } from "effect";
import { parseRoute, type RouteInfo } from "../../src/shared/routes.js";
import { User } from "../../src/shared/schemas.js";
import type { PageState } from "../../src/shared/dehydrate.js";
import { CurrentSession } from "../apiSchema.js";
import { getCommit, getHeadCommit } from "./playgroundRepo.js";
import { SessionService, sessionCookieName } from "../services/sessionService.js";
import { withRequestTransaction } from "../db.js";

const parseSessionToken = (cookieHeader: string | null): string | undefined =>
  pipe(
    Option.fromNullishOr(cookieHeader),
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
    const sessionService = yield* SessionService;
    const sessionResult = yield* sessionService.validateSessionToken(token);

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

    const commit = yield* routeCommit(route).pipe(
      Effect.provideService(CurrentSession, sessionResult),
      // The page renders without the commit rather than answering an error:
      // the workbench boots either way and asks for the playground itself, so
      // a failure here costs a round trip instead of the whole page. What it
      // must not do is look like an empty playground, so it is logged.
      Effect.tapError((error) =>
        Effect.logError("Rendering the page without its commit").pipe(
          Effect.annotateLogs({ pathname, reason: String(error) }),
        ),
      ),
      Effect.orElseSucceed(() => null),
    );

    return { user, commit, route } satisfies PageState;
  }).pipe(
    // The same policy one level out: a visitor whose session cannot be read is
    // served the page as a stranger, and the reason is recorded.
    Effect.tapCause((cause) =>
      Effect.logError("Rendering the page with no initial data").pipe(
        Effect.annotateLogs({ pathname, reason: Cause.pretty(cause) }),
      ),
    ),
    Effect.orElseSucceed(
      () => ({ user: null, commit: null, route: parseRoute(pathname) }) satisfies PageState,
    ),
    withRequestTransaction,
  );

/** The commit the route names, or `null` when the route names none. */
const routeCommit = (route: RouteInfo | null) => {
  if (!route) return Effect.succeed(null);
  if (route.type === "commit" && route.commitId && route.playgroundHash) {
    return getCommit(route.playgroundHash, route.commitId);
  }
  if (route.type === "playground" && route.playgroundHash) {
    return getHeadCommit(route.playgroundHash);
  }
  return Effect.succeed(null);
};
