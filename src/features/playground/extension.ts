/**
 * Playground Extension - Main activation
 */

import * as vscode from "vscode";
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import { PlaygroundPanelProvider } from "./providers/PlaygroundPanelProvider";
import { PlaygroundBrowserPanel } from "./providers/PlaygroundBrowserEditor";
import { PlaygroundService } from "./services/PlaygroundService";
import { getCurrentPlaygroundId } from "../../routes";
import {
  PLAYGROUND_SHOW_BROWSER,
  PLAYGROUND_OPEN,
  PLAYGROUND_OPEN_CURRENT,
  PLAYGROUND_REFRESH_METADATA,
  PLAYGROUND_CREATE,
  PLAYGROUND_METADATA,
} from "../constants";

const ext = registerExtension(
  {
    name: "postgres-garden-playground",
    publisher: "postgres-garden",
    version: "1.0.0",
    engines: {
      vscode: "*",
    },
    contributes: {
      views: {
        scm: [
          {
            id: PLAYGROUND_METADATA,
            name: "Playground Info",
            when: "true",
          },
        ],
      },
      commands: [
        {
          command: PLAYGROUND_SHOW_BROWSER,
          title: "Show Playgrounds",
          icon: "$(database)",
        },
        {
          command: PLAYGROUND_OPEN,
          title: "Open Playground Metadata",
        },
        {
          command: PLAYGROUND_OPEN_CURRENT,
          title: "Edit Current Playground Metadata",
          icon: "$(edit)",
        },
        {
          command: PLAYGROUND_CREATE,
          title: "Create Playground",
          icon: "$(add)",
        },
        {
          command: PLAYGROUND_REFRESH_METADATA,
          title: "Refresh Playground Metadata",
          icon: "$(refresh)",
        },
      ],
      menus: {
        "view/title": [
          {
            command: PLAYGROUND_OPEN_CURRENT,
            when: `view == ${PLAYGROUND_METADATA}`,
            group: "navigation",
          },
          {
            command: PLAYGROUND_REFRESH_METADATA,
            when: `view == ${PLAYGROUND_METADATA}`,
            group: "navigation",
          },
        ],
      },
    },
  },
  ExtensionHostKind.LocalProcess,
);

// Tree item class for metadata view
class PlaygroundMetadataItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode
      .TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
  }
}

// TreeDataProvider for the metadata view
class PlaygroundMetadataProvider implements vscode.TreeDataProvider<PlaygroundMetadataItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    PlaygroundMetadataItem | undefined | null | void
  > = new vscode.EventEmitter<PlaygroundMetadataItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<PlaygroundMetadataItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private service: PlaygroundService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PlaygroundMetadataItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PlaygroundMetadataItem): Promise<PlaygroundMetadataItem[]> {
    if (element) {
      return [];
    }

    const playgroundId = getCurrentPlaygroundId();
    if (!playgroundId) {
      return [
        new PlaygroundMetadataItem(
          "No playground loaded",
          "Open or create a playground to see details",
        ),
      ];
    }

    try {
      const playground = await this.service.getPlayground(playgroundId);
      return [
        new PlaygroundMetadataItem("Name", playground.name || "Untitled"),
        new PlaygroundMetadataItem(
          "Privacy",
          playground.privacy.charAt(0).toUpperCase() + playground.privacy.slice(1),
        ),
        new PlaygroundMetadataItem("Description", playground.description || undefined),
        new PlaygroundMetadataItem("Created", new Date(playground.created_at).toLocaleDateString()),
      ];
    } catch (error) {
      console.error("Failed to load playground metadata:", error);
      return [new PlaygroundMetadataItem("Error", "Failed to load metadata")];
    }
  }
}

void ext.getApi().then((vscode: typeof import("vscode")) => {
  console.log("Playground extension activated");

  const service = new PlaygroundService();
  const subscriptions = [];

  // Get extension URI - use the current origin in dev mode
  // In monaco-vscode-api, we use the window origin for webview resources
  const extensionUri = vscode.Uri.parse(window.location.origin);

  console.log("Extension URI:", extensionUri.toString());

  // Create and register the metadata tree view
  const metadataProvider = new PlaygroundMetadataProvider(service);
  const metadataTreeView = vscode.window.createTreeView(PLAYGROUND_METADATA, {
    treeDataProvider: metadataProvider,
  });
  subscriptions.push(metadataTreeView);

  // Register command to show playground browser
  subscriptions.push(
    vscode.commands.registerCommand(PLAYGROUND_SHOW_BROWSER, () => {
      console.log("[Playground] Opening playground browser...");
      try {
        PlaygroundBrowserPanel.createOrShow(extensionUri, service);
        console.log("[Playground] Playground browser opened successfully");
      } catch (err) {
        console.error("[Playground] Failed to open playground browser:", err);
      }
    }),
  );

  console.log("Playground browser command registered");

  // Register command to open playground in panel
  subscriptions.push(
    vscode.commands.registerCommand(PLAYGROUND_OPEN, (playgroundId: string) => {
      PlaygroundPanelProvider.createOrShow(extensionUri, playgroundId, service);
    }),
  );

  // Register command to open metadata panel for currently active playground (based on URL)
  subscriptions.push(
    vscode.commands.registerCommand(PLAYGROUND_OPEN_CURRENT, () => {
      const playgroundId = getCurrentPlaygroundId();

      if (!playgroundId) {
        vscode.window.showInformationMessage(
          "No playground is currently loaded. Save your workspace first to create a playground.",
        );
        return;
      }

      // TODO: Fix PlaygroundPanelProvider to use hash instead of numeric ID
      vscode.window.showInformationMessage(
        "Please use the edit button in the Playground Info panel (SCM sidebar) to edit playground metadata.",
      );
    }),
  );

  // Register command to refresh metadata view
  subscriptions.push(
    vscode.commands.registerCommand(PLAYGROUND_REFRESH_METADATA, () => {
      metadataProvider.refresh();
    }),
  );

  // Register command to create new playground
  subscriptions.push(
    vscode.commands.registerCommand(PLAYGROUND_CREATE, async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Enter playground name",
        placeHolder: "my-playground",
        validateInput: (value) => {
          if (!value) return "Name is required";
          if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            return "Name can only contain letters, numbers, hyphens, and underscores";
          }
          return null;
        },
      });

      if (name) {
        try {
          const playground = await service.createPlayground({
            name,
            privacy: "private",
          });

          // Navigate to the new playground
          const url = `/playgrounds/${playground.hash}`;
          if (window.navigation) {
            window.navigation.navigate(url);
          } else {
            window.location.href = url;
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create playground: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }),
  );
});
