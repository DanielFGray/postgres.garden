/**
 * Frontend Router using Navigation API
 *
 * Handles client-side navigation for SPA routing while maintaining SSR compatibility.
 * Uses the Navigation API polyfill for cross-browser support.
 */

import "@virtualstate/navigation/polyfill";
import { parseRoute, type Route, routesEqual } from "./routes";

export type RouteChangeHandler = (route: Route) => void | Promise<void>;

interface RouterOptions {
  /**
   * Called when a navigation is intercepted and committed
   */
  onRouteChange?: RouteChangeHandler;

  /**
   * Called when a navigation fails
   */
  onNavigationError?: (error: Error, route: Route | null) => void;

  /**
   * Should this navigation be intercepted?
   * Return false to allow default browser navigation (full page reload)
   */
  shouldIntercept?: (event: NavigateEvent) => boolean;
}

export class Router {
  private currentRoute: Route | null = null;
  private options: RouterOptions;

  constructor(options: RouterOptions = {}) {
    this.options = options;
    this.currentRoute = parseRoute(window.location.href);
  }

  /**
   * Initialize the router and start intercepting navigations
   */
  init(): void {
    if (!window.navigation) {
      console.error("Navigation API not available. Routing will not work.");
      return;
    }

    // Listen for navigate events
    window.navigation.addEventListener("navigate", (event) => {
      this.handleNavigate(event);
    });

    // Listen for navigation success/error
    window.navigation.addEventListener("navigatesuccess", () => {
      console.log("Navigation succeeded:", this.currentRoute);
    });

    window.navigation.addEventListener("navigateerror", () => {
      const error = new Error("Navigation failed");
      console.error("Navigation failed:", error);
      this.options.onNavigationError?.(error, this.currentRoute);
    });

    console.log("Router initialized with route:", this.currentRoute);
  }

  /**
   * Handle navigate events
   */
  private handleNavigate(event: NavigateEvent): void {
    // Check if we should intercept this navigation
    if (!this.shouldInterceptNavigation(event)) {
      return;
    }

    const route = parseRoute(event.destination.url);

    // If route is invalid, let browser handle it (404)
    if (!route) {
      console.warn("Unknown route:", event.destination.url);
      return;
    }

    // If same route, don't intercept (allows default scroll behavior)
    if (routesEqual(route, this.currentRoute)) {
      return;
    }

    // Intercept the navigation
    event.intercept({
      handler: async () => {
        await this.performRouteChange(route);
      },
    });
  }

  /**
   * Determine if we should intercept this navigation
   */
  private shouldInterceptNavigation(event: NavigateEvent): boolean {
    // Allow custom shouldIntercept check
    if (this.options.shouldIntercept && !this.options.shouldIntercept(event)) {
      return false;
    }

    // Don't intercept if:
    // - Not a same-origin navigation
    if (!event.canIntercept) {
      return false;
    }

    // - It's a download
    if (event.downloadRequest) {
      return false;
    }

    // - It's a form submission (for now)
    if (event.formData) {
      return false;
    }

    // - It's a reload
    if (event.navigationType === "reload") {
      return false;
    }

    return true;
  }

  /**
   * Perform the route change
   */
  private async performRouteChange(route: Route): Promise<void> {
    console.log("Navigating to route:", route);

    this.currentRoute = route;

    // Call the route change handler
    if (this.options.onRouteChange) {
      await this.options.onRouteChange(route);
    }
  }

  /**
   * Navigate to a route programmatically
   */
  navigate(type: Route["type"], params: Route["params"] = {}): void {
    const path = this.buildPath(type, params);
    window.navigation.navigate(path);
  }

  /**
   * Navigate to a URL path
   */
  navigateToPath(path: string): void {
    window.navigation.navigate(path);
  }

  /**
   * Go back in history
   */
  back(): void {
    window.navigation.back();
  }

  /**
   * Go forward in history
   */
  forward(): void {
    window.navigation.forward();
  }

  /**
   * Get the current route
   */
  getCurrentRoute(): Route | null {
    return this.currentRoute;
  }

  /**
   * Update the current route without triggering navigation
   * Useful when the application state changes in a way that should be reflected in the route
   * For example, after saving a workspace to a new playground, we update the route
   * so subsequent navigations know we're already at that playground
   */
  updateCurrentRoute(route: Route): void {
    this.currentRoute = route;
    console.log("Router current route updated:", route);
  }

  /**
   * Build a path for a route
   */
  private buildPath(type: Route["type"], params: Route["params"]): string {
    switch (type) {
      case "home":
        return "/";
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
        throw new Error(`Unknown route type: ${type}`);
    }
  }
}

/**
 * Create and initialize a router instance
 */
export function createRouter(options: RouterOptions = {}): Router {
  const router = new Router(options);
  router.init();
  return router;
}
