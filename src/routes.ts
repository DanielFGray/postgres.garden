/**
 * Route definitions and path parsing utilities
 *
 * Route structure:
 * / - Home
 * /playgrounds/:id - Playground (latest commit)
 * /playgrounds/:id/commits/:commit - Specific commit in playground
 */

import { URLPattern } from "urlpattern-polyfill";

export interface RouteParams {
  playgroundId?: string;
  commitId?: string;
  data?: string;
}

export type RouteType = "home" | "playground" | "commit" | "shared";

export interface Route {
  type: RouteType;
  params: RouteParams;
  path: string;
}

// Route patterns
const patterns = {
  home: new URLPattern({ pathname: "/" }),
  shared: new URLPattern({ pathname: "/s/:data" }),
  playground: new URLPattern({ pathname: "/playgrounds/:playgroundId" }),
  commit: new URLPattern({
    pathname: "/playgrounds/:playgroundId/commits/:commitId",
  }),
};

/**
 * Parse a URL and return route information
 */
export function parseRoute(url: string | URL): Route | null {
  const urlObj =
    typeof url === "string" ? new URL(url, window.location.origin) : url;

  // Try most specific routes first
  const commitMatch = patterns.commit.exec(urlObj);
  if (commitMatch) {
    return {
      type: "commit",
      params: {
        playgroundId: commitMatch.pathname.groups.playgroundId,
        commitId: commitMatch.pathname.groups.commitId,
      },
      path: urlObj.pathname,
    };
  }

  const sharedMatch = patterns.shared.exec(urlObj);
  if (sharedMatch) {
    return {
      type: "shared",
      params: {
        data: sharedMatch.pathname.groups.data,
      },
      path: urlObj.pathname,
    };
  }

  const playgroundMatch = patterns.playground.exec(urlObj);
  if (playgroundMatch) {
    return {
      type: "playground",
      params: {
        playgroundId: playgroundMatch.pathname.groups.playgroundId,
      },
      path: urlObj.pathname,
    };
  }

  const homeMatch = patterns.home.exec(urlObj);
  if (homeMatch) {
    return {
      type: "home",
      params: {},
      path: urlObj.pathname,
    };
  }

  return null;
}

/**
 * Build a URL path for a given route
 */
export function buildPath(type: RouteType, params: RouteParams): string {
  switch (type) {
    case "home":
      return "/";
    case "shared":
      if (!params.data) {
        throw new Error("data is required for shared route");
      }
      return `/s/${params.data}`;
    case "playground":
      if (!params.playgroundId) {
        throw new Error("playgroundId is required for playground route");
      }
      return `/playgrounds/${params.playgroundId}`;
    case "commit":
      if (!params.playgroundId || !params.commitId) {
        throw new Error(
          "playgroundId and commitId are required for commit route",
        );
      }
      return `/playgrounds/${params.playgroundId}/commits/${params.commitId}`;
    default:
      throw new Error(`Unknown route type: ${type as string}`);
  }
}

/**
 * Check if two routes are equal
 */
export function routesEqual(a: Route | null, b: Route | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.type === b.type &&
    a.params.playgroundId === b.params.playgroundId &&
    a.params.commitId === b.params.commitId &&
    a.params.data === b.params.data
  );
}

/**
 * Get the current playground ID from the browser URL
 * Returns null if we're on the home page (unsaved workspace)
 */
export function getCurrentPlaygroundId(): string | null {
  const route = parseRoute(window.location.href);
  if (!route || route.type === "home") {
    return null;
  }
  return route.params.playgroundId || null;
}
