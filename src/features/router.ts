import { Effect, Layer, Runtime } from "effect";
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

export const RouterFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const onPopState = () => {
      Runtime.runFork(runtime)(
        loadCurrentRoute().pipe(
          Effect.tapErrorCause((cause) => Effect.logError("Route loading failed", cause)),
          Effect.catchAllCause(() => Effect.void),
        ),
      );
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("popstate", onPopState)),
      () => Effect.sync(() => window.removeEventListener("popstate", onPopState)),
    );
  }),
);
