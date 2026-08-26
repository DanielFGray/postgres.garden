import { URLPattern } from "urlpattern-polyfill";

export type RouteType =
  | "home"
  | "shared"
  | "playground"
  | "commit"
  | "verify"
  | "reset"
  | "settings";

export interface RouteInfo {
  readonly type: RouteType;
  readonly playgroundHash?: string;
  readonly commitId?: string;
  readonly data?: string;
}

const patterns = {
  home: new URLPattern({ pathname: "/" }),
  shared: new URLPattern({ pathname: "/s/:data" }),
  playground: new URLPattern({ pathname: "/playgrounds/:playgroundId" }),
  commit: new URLPattern({
    pathname: "/playgrounds/:playgroundId/commits/:commitId",
  }),
  verify: new URLPattern({ pathname: "/verify" }),
  reset: new URLPattern({ pathname: "/reset" }),
  settings: new URLPattern({ pathname: "/settings" }),
} as const;

export const parseRoute = (url: string | URL): RouteInfo | null => {
  const value = typeof url === "string" ? new URL(url, "http://localhost") : url;

  const commit = patterns.commit.exec(value);
  if (commit) {
    return {
      type: "commit",
      playgroundHash: commit.pathname.groups.playgroundId,
      commitId: commit.pathname.groups.commitId,
    };
  }

  const shared = patterns.shared.exec(value);
  if (shared) return { type: "shared", data: shared.pathname.groups.data };

  const playground = patterns.playground.exec(value);
  if (playground) {
    return { type: "playground", playgroundHash: playground.pathname.groups.playgroundId };
  }

  if (patterns.verify.test(value)) return { type: "verify" };
  if (patterns.reset.test(value)) return { type: "reset" };
  if (patterns.settings.test(value)) return { type: "settings" };
  if (patterns.home.test(value)) return { type: "home" };
  return null;
};

export const buildPath = (route: RouteInfo): string => {
  switch (route.type) {
    case "home":
      return "/";
    case "shared":
      return `/s/${encodeURIComponent(route.data ?? "")}`;
    case "playground":
      return `/playgrounds/${encodeURIComponent(route.playgroundHash ?? "")}`;
    case "commit":
      return `/playgrounds/${encodeURIComponent(route.playgroundHash ?? "")}/commits/${encodeURIComponent(route.commitId ?? "")}`;
    case "verify":
      return "/verify";
    case "reset":
      return "/reset";
    case "settings":
      return "/settings";
  }
};

export const getCurrentPlaygroundId = (): string | null =>
  parseRoute(window.location.href)?.playgroundHash ?? null;
