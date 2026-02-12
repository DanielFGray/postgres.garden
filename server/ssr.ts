/**
 * Simplified SSR data fetching
 * Convention: pathname → API endpoint mapping
 */

import { treaty } from "@elysiajs/eden";
import type { App } from "./app.js";
import { URLPattern } from "urlpattern-polyfill";

// Route patterns (same as in src/routes.ts)
const patterns = {
  home: new URLPattern({ pathname: "/" }),
  shared: new URLPattern({ pathname: "/s/:data" }),
  playground: new URLPattern({ pathname: "/playgrounds/:playgroundId" }),
  commit: new URLPattern({
    pathname: "/playgrounds/:playgroundId/commits/:commitId",
  }),
};

interface Route {
  type: "home" | "playground" | "commit" | "shared";
  params: { playgroundId?: string; commitId?: string; data?: string };
}

/**
 * Parse a pathname to extract route info
 */
function parsePathname(pathname: string): Route | null {
  // Create a URL object with a dummy origin for URLPattern matching
  const urlObj = new URL(pathname, "http://localhost");

  // Try most specific routes first
  const commitMatch = patterns.commit.exec(urlObj);
  if (commitMatch) {
    return {
      type: "commit",
      params: {
        playgroundId: commitMatch.pathname.groups.playgroundId,
        commitId: commitMatch.pathname.groups.commitId,
      },
    };
  }

  const sharedMatch = patterns.shared.exec(urlObj);
  if (sharedMatch) {
    return {
      type: "shared",
      params: {
        data: sharedMatch.pathname.groups.data,
      },
    };
  }

  const playgroundMatch = patterns.playground.exec(urlObj);
  if (playgroundMatch) {
    return {
      type: "playground",
      params: {
        playgroundId: playgroundMatch.pathname.groups.playgroundId,
      },
    };
  }

  const homeMatch = patterns.home.exec(urlObj);
  if (homeMatch) {
    return {
      type: "home",
      params: {},
    };
  }

  return null;
}

/**
 * Fetch initial SSR data by calling the corresponding API endpoint
 *
 * Convention:
 * - "/" → "/me" (home page only needs user data)
 * - "/playgrounds/:id" → "/api/playgrounds/:id" + latest commit data
 * - "/playgrounds/:id/commits/:commitId" → "/api/playgrounds/:id/commits/:commitId"
 *
 * Returns data in the format expected by loadWorkspaceFromInitialData:
 * { user, route, commit }
 */
export async function getInitialData(
  app: App,
  pathname: string,
  cookieHeader: string,
): Promise<unknown> {
  // Create treaty client for in-memory API calls
  const client = treaty(app);
  const fetchOpts = { fetch: { headers: { Cookie: cookieHeader } } };

  try {
    // Always fetch user data using /me (returns user directly, not wrapped)
    const { data: user } = await client.me.get(fetchOpts);

    // Parse the route to understand what we're loading
    const route = parsePathname(pathname);

    // If home page or invalid route, just return user data
    if (!route || route.type === "home") {
      return { user, route: null, commit: null };
    }

    // Shared routes: data is encoded in the URL, no server-side fetch needed
    if (route.type === "shared") {
      return { user, route, commit: null };
    }

    // For playground routes, fetch the playground and commit data
    if (route.type === "playground" || route.type === "commit") {
      const hash = route.params.playgroundId!;

      // Fetch playground info
      const { data: playground } = await client.api
        .playgrounds({ hash })
        .get(fetchOpts);

      if (!playground || "error" in playground) {
        return { user, route, commit: null };
      }

      let commit = null;

      // If it's a specific commit, fetch that commit
      if (route.type === "commit" && route.params.commitId) {
        const { data } = await client.api
          .playgrounds({ hash })
          .commits({ commit_id: route.params.commitId })
          .get(fetchOpts);
        commit = data;
      } else if (route.type === "playground") {
        // For playground routes without specific commit, fetch the latest commit
        const { data: commits } = await client.api
          .playgrounds({ hash })
          .commits.get(fetchOpts);

        if (Array.isArray(commits) && commits.length > 0) {
          // Get the first commit (latest, since they're ordered by created_at desc)
          const latestCommitId = commits[0]!.id;
          const { data } = await client.api
            .playgrounds({ hash })
            .commits({ commit_id: latestCommitId })
            .get(fetchOpts);
          commit = data;
        }
      }

      return { user, route, commit };
    }

    return { user, route: null, commit: null };
  } catch (error) {
    console.error(`[SSR] Failed to fetch ${pathname}:`, error);
    return null;
  }
}


