/**
 * Router initialization feature
 * Integrates the Navigation API router with the workbench
 */

import { createRouter } from "../router";
import type { Route } from "../routes";
import { loadWorkspace, loadWorkspaceFromSharedUrl } from "./workspaceSwitcher";
import { parseRoute } from "../routes";

console.log("Initializing router...");

// Handler for route changes
async function handleRouteChange(route: Route) {
  console.log("Route changed:", route);

  // Handle route changes by loading the appropriate workspace
  switch (route.type) {
    case "home":
      console.log("Navigated to home");
      // Sample workspace is loaded in workspaceSwitcher.ts
      // No action needed here
      break;

    case "playground":
      console.log("Navigated to playground:", route.params.playgroundId);
      if (route.params.playgroundId) {
        try {
          await loadWorkspace({
            playgroundHash: route.params.playgroundId,
            updateUrl: false, // Already navigated via router
          });
        } catch (err) {
          console.error("Failed to load playground:", err);
        }
      }
      break;

    case "commit":
      console.log(
        "Navigated to commit:",
        route.params.commitId,
        "in playground:",
        route.params.playgroundId,
      );
      if (route.params.playgroundId && route.params.commitId) {
        try {
          await loadWorkspace({
            playgroundHash: route.params.playgroundId,
            commitId: route.params.commitId,
            updateUrl: false, // Already navigated via router
          });
        } catch (err) {
          console.error("Failed to load commit:", err);
        }
      }
      break;

    case "shared":
      console.log("Navigated to shared workspace");
      if (route.params.data) {
        try {
          await loadWorkspaceFromSharedUrl(route.params.data);
        } catch (err) {
          console.error("Failed to load shared workspace:", err);
        }
      }
      break;
  }
}

// Create and initialize the router
const router = createRouter({
  onRouteChange: handleRouteChange,

  onNavigationError: (error: Error, route: Route | null) => {
    console.error("Navigation error:", error, "Route:", route);
  },

  shouldIntercept: () => {
    // Allow all same-origin navigations to be intercepted by default
    // The router will handle filtering
    return true;
  },
});

// Handle the initial route on page load (after VSCode API is ready)
// The router doesn't automatically call onRouteChange for the initial route
// Wait for window.vscodeReady to be set before handling initial route
//
// NOTE: When SSR provides commit data (__INITIAL_DATA__.commit), the workspace
// is loaded by loadWorkspaceFromInitialData() in postgres.ts — the router should
// NOT re-load it (which would make redundant API calls and race with the SSR load).
// The router only handles initial routes for shared URLs (where SSR defers to client).
const waitForVSCode = async () => {
  // Skip if SSR already loaded workspace data
  const initialData = window.__INITIAL_DATA__;
  if (initialData?.commit) {
    console.log("Skipping initial route — SSR already loaded workspace data");
    return;
  }

  // If VSCode API is already ready, handle route immediately
  if (window.vscodeReady) {
    const initialRoute = parseRoute(window.location.href);
    if (initialRoute) {
      console.log("Handling initial route:", initialRoute);
      await handleRouteChange(initialRoute);
    }
    return;
  }

  // Otherwise wait for the ready event
  return new Promise<void>((resolve) => {
    const checkReady = () => {
      if (window.vscodeReady) {
        const initialRoute = parseRoute(window.location.href);
        if (initialRoute) {
          console.log("Handling initial route:", initialRoute);
          void handleRouteChange(initialRoute).then(resolve);
        } else {
          resolve();
        }
      } else {
        setTimeout(checkReady, 100);
      }
    };
    checkReady();
  });
};

void waitForVSCode();

// Expose router globally for debugging and programmatic navigation
if (typeof window !== "undefined") {
  window.__router = router;
}

export { router };
