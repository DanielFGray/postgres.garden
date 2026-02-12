import { buildPath, type RouteParams, type RouteType } from "./routes";

/**
 * Replace current URL without adding to history
 */
export function replaceTo(type: RouteType, params: RouteParams = {}): void {
  const path = buildPath(type, params);
  if (typeof window !== "undefined" && window.navigation) {
    window.navigation.navigate(path, { history: "replace" });
  }
}
