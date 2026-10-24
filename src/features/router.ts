import { Effect, Layer } from "effect";
import { parseRoute } from "../shared/routes";
import { loadWorkspace, loadWorkspaceFromSharedUrl } from "./workspaceSwitcher";

const loadCurrentRoute = () => {
  const route = parseRoute(window.location.href);
  if (!route) return Effect.void;

  switch (route.type) {
    case "playground":
      return route.playgroundHash
        ? loadWorkspace({ playgroundHash: route.playgroundHash, updateUrl: false })
        : Effect.void;
    case "commit":
      return route.playgroundHash && route.commitId
        ? loadWorkspace({
            playgroundHash: route.playgroundHash,
            commitId: route.commitId,
            updateUrl: false,
          })
        : Effect.void;
    case "shared":
      return route.data ? loadWorkspaceFromSharedUrl(route.data) : Effect.void;
    default:
      return Effect.void;
  }
};

export const RouterFeatureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* Effect.context<never>();
    const onPopState = () => {
      Effect.runForkWith(runtime)(
        loadCurrentRoute().pipe(
          Effect.tapCause((cause) => Effect.logError("Route loading failed", cause)),
          Effect.ignoreCause,
        ),
      );
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("popstate", onPopState)),
      () => Effect.sync(() => window.removeEventListener("popstate", onPopState)),
    );
  }),
);
