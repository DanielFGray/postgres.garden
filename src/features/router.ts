import { Effect, Layer } from "effect";
import { parseRoute } from "../shared/routes";
import { WorkspaceSwitcher } from "./workspaceSwitcher";

export const RouterFeatureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspace = yield* WorkspaceSwitcher;
    const runtime = yield* Effect.context<never>();

    const loadCurrentRoute = () => {
      const route = parseRoute(window.location.href);
      if (!route) return Effect.void;

      switch (route.type) {
        case "playground":
          return route.playgroundHash
            ? workspace.loadWorkspace({ playgroundHash: route.playgroundHash, updateUrl: false })
            : Effect.void;
        case "commit":
          return route.playgroundHash && route.commitId
            ? workspace.loadWorkspace({
                playgroundHash: route.playgroundHash,
                commitId: route.commitId,
                updateUrl: false,
              })
            : Effect.void;
        case "shared":
          return route.data ? workspace.loadWorkspaceFromSharedUrl(route.data) : Effect.void;
        default:
          return Effect.void;
      }
    };

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
