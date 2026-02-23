/**
 * Fibrae Route definitions for postgres.garden
 *
 * Shared between server (SSR) and client (SPA).
 * Replaces route-contract.ts and routes.ts.
 */

import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Route, Router } from "fibrae/router";

// =============================================================================
// Route Definitions
// =============================================================================

export const homeRoute = Route.get("home", "/");

export const sharedRoute = Route.get(
  "shared",
)`/s/${Route.param("data", Schema.String)}`;

export const playgroundRoute = Route.get(
  "playground",
)`/playgrounds/${Route.param("playgroundId", Schema.String)}`;

export const commitRoute = Route.get(
  "commit",
)`/playgrounds/${Route.param("playgroundId", Schema.String)}/commits/${Route.param("commitId", Schema.String)}`;

// =============================================================================
// Router
// =============================================================================

export const PgRouter = Router.make("PgRouter").add(
  Router.group("pages")
    .add(homeRoute)
    .add(sharedRoute)
    .add(playgroundRoute)
    .add(commitRoute),
);

// =============================================================================
// Utilities
// =============================================================================

/**
 * Extract the playground ID from the current URL pathname.
 */
export function getCurrentPlaygroundId(): string | null {
  const match = PgRouter.matchRoute(window.location.pathname);
  if (Option.isNone(match)) return null;
  const params = match.value.params as { playgroundId?: string };
  return params.playgroundId ?? null;
}
