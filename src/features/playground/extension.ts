/**
 * Playground Extension - Main activation
 */

import * as vscode from "vscode";
import { Effect, Layer } from "effect";
import { PlaygroundBrowserPanel } from "./providers/PlaygroundBrowserEditor";
import { PlaygroundMetadataViewProvider } from "./providers/PlaygroundMetadataViewProvider";
import { PlaygroundService } from "./services/PlaygroundService";
import { getCurrentPlaygroundId } from "../../shared/routes";
import { Workbench } from "../../workbench";
import {
  PLAYGROUND_SHOW_BROWSER,
  PLAYGROUND_OPEN,
  PLAYGROUND_OPEN_CURRENT,
  PLAYGROUND_REFRESH_METADATA,
  PLAYGROUND_CREATE,
  PLAYGROUND_TOGGLE_STAR,
  PLAYGROUND_METADATA,
} from "../constants";
import { VSCodeService } from "../../vscode/service";

const activatePlaygroundExtension = Effect.gen(function* () {
  const vscodeService = yield* VSCodeService;
  const { runFork } = yield* Workbench;
  const vscodeApi = vscodeService.api;

  const service = new PlaygroundService();
  const subscriptions: vscode.Disposable[] = [];
  const extensionUri = vscodeService.extensionUri;

  console.log("Playground extension activated");
  console.log("Extension URI:", extensionUri.toString());

  const metadataProvider = new PlaygroundMetadataViewProvider(extensionUri);
  subscriptions.push(
    vscodeApi.window.registerWebviewViewProvider(PLAYGROUND_METADATA, metadataProvider),
  );

  const refreshMetadata = Effect.sync(() => {
    const playgroundId = getCurrentPlaygroundId();
    metadataProvider.refresh(playgroundId);
  });

  runFork(refreshMetadata);

  yield* vscodeService.registerCommand(PLAYGROUND_SHOW_BROWSER, () => {
    runFork(
      Effect.sync(() => {
        PlaygroundBrowserPanel.createOrShow(extensionUri);
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            console.error("[Playground] Failed to open playground browser:", error);
          }),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    );
  });

  yield* vscodeService.registerCommand(PLAYGROUND_OPEN, (playgroundId) => {
    if (typeof playgroundId !== "string") {
      return;
    }

    metadataProvider.refresh(playgroundId);
  });

  yield* vscodeService.registerCommand(PLAYGROUND_OPEN_CURRENT, () => {
    const playgroundId = getCurrentPlaygroundId();
    if (!playgroundId) {
      void vscodeApi.window.showInformationMessage(
        "No playground is currently loaded. Save your workspace first to create a playground.",
      );
      return;
    }

    // Trigger save from the sidebar
    metadataProvider.triggerSave();
  });

  yield* vscodeService.registerCommand(PLAYGROUND_REFRESH_METADATA, () => {
    runFork(refreshMetadata);
  });

  // Refresh metadata on navigation (route changes update the playground ID)
  if (window.navigation) {
    const onNavigateSuccess = () => {
      runFork(refreshMetadata);
    };
    window.navigation.addEventListener("navigatesuccess", onNavigateSuccess);
    subscriptions.push({
      dispose: () => window.navigation.removeEventListener("navigatesuccess", onNavigateSuccess),
    });
  }

  yield* vscodeService.registerCommand(PLAYGROUND_TOGGLE_STAR, () => {
    runFork(
      Effect.gen(function* () {
        const playgroundId = getCurrentPlaygroundId();
        if (!playgroundId) return;

        yield* service.toggleStar(playgroundId);
        yield* refreshMetadata;
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            void vscodeApi.window.showErrorMessage(
              `Failed to toggle star: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    );
  });

  yield* vscodeService.registerCommand(PLAYGROUND_CREATE, () => {
    runFork(
      Effect.gen(function* () {
        const name = yield* Effect.tryPromise({
          try: () =>
            vscodeApi.window.showInputBox({
              prompt: "Enter playground name",
              placeHolder: "my-playground",
              validateInput: (value) => {
                if (!value) return "Name is required";
                if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                  return "Name can only contain letters, numbers, hyphens, and underscores";
                }
                return null;
              },
            }),
          catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
        });

        if (!name) {
          return;
        }

        const playground = yield* service.createPlayground({
          name,
          privacy: "private",
        });

        const url = `/playgrounds/${playground.hash}`;
        if (window.navigation) {
          window.navigation.navigate(url);
          return;
        }

        window.location.href = url;
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            void vscodeApi.window.showErrorMessage(
              `Failed to create playground: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    );
  });

  return yield* Effect.acquireRelease(
    Effect.succeed(subscriptions),
    (all) =>
      Effect.sync(() => {
        all.forEach((disposable) => {
          disposable.dispose();
        });
      }),
  );
});

export const PlaygroundExtensionLive = Layer.scopedDiscard(
  activatePlaygroundExtension.pipe(Effect.withSpan("feature.playground")),
);
