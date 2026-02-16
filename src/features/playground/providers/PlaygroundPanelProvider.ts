/**
 * Webview Panel Provider for Playground Editor
 */

import * as vscode from "vscode";
import type {
  Playground,
  Privacy,
  PanelToExtensionMessage,
  ExtensionToPanelMessage,
} from "../types";
import { PlaygroundService } from "../services/PlaygroundService";

export class PlaygroundPanelProvider {
  public static readonly viewType = "playgroundPanel.editor";
  private static panels: Map<string, PlaygroundPanelProvider> = new Map();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private service: PlaygroundService;
  private playground?: Playground;
  private saveTimeout?: NodeJS.Timeout;

  public static createOrShow(
    extensionUri: vscode.Uri,
    playgroundId: string,
    service?: PlaygroundService,
  ) {
    const column =
      vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    // Check if we already have a panel for this playground
    const existingPanel = PlaygroundPanelProvider.panels.get(playgroundId);
    if (existingPanel) {
      existingPanel._panel.reveal(column);
      return;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      PlaygroundPanelProvider.viewType,
      "Loading...",
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(
            extensionUri,
            "src",
            "features",
            "playground",
            "webview",
            "panel",
          ),
        ],
        retainContextWhenHidden: true,
      },
    );

    const provider = new PlaygroundPanelProvider(
      panel,
      extensionUri,
      playgroundId,
      service,
    );
    PlaygroundPanelProvider.panels.set(playgroundId, provider);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private playgroundId: string,
    service?: PlaygroundService,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.service = service || new PlaygroundService();

    // Set initial HTML
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Load playground data
    void this._loadPlayground();

    // Handle dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: PanelToExtensionMessage) => this._handleMessage(message),
      null,
      this._disposables,
    );
  }

  private async _loadPlayground() {
    try {
      this.playground = await this.service.getPlayground(this.playgroundId);
      this._panel.title = this.playground.name ?? "Untitled";

      this._postMessage({
        type: "loadPlayground",
        data: this.playground,
      });
    } catch (error) {
      console.error("Failed to load playground:", error);
      this._postMessage({
        type: "error",
        data: { message: "Failed to load playground" },
      });
    }
  }

  private async _handleMessage(message: PanelToExtensionMessage) {
    switch (message.type) {
      case "initialized":
        // Webview is ready, send playground data
        if (this.playground) {
          this._postMessage({
            type: "loadPlayground",
            data: this.playground,
          });
        }
        break;

      case "updateMetadata":
        await this._updateMetadata(message.data);
        break;

      case "fork":
        await this._forkPlayground();
        break;
    }
  }

  private async _updateMetadata(data: {
    name?: string;
    description?: string;
    privacy?: string;
  }) {
    if (!this.playground) return;

    try {
      this.playground = await this.service.updatePlayground(
        this.playground.hash,
        {
          name: data.name,
          description: data.description,
          privacy: data.privacy as Privacy,
        },
      );

      this._panel.title = this.playground.name ?? "Untitled";

      this._postMessage({
        type: "saved",
        data: { timestamp: new Date().toISOString() },
      });
    } catch (error) {
      console.error("Failed to update metadata:", error);
      this._postMessage({
        type: "error",
        data: { message: "Failed to update metadata" },
      });
    }
  }

  private async _forkPlayground() {
    if (!this.playground) return;

    try {
      const fork = await this.service.forkPlayground(this.playground.hash);

      // Open the forked playground in a new panel
      vscode.commands.executeCommand("playground.open", fork.hash);
    } catch (error) {
      console.error("Failed to fork playground:", error);
      this._postMessage({
        type: "error",
        data: { message: "Failed to fork playground" },
      });
    }
  }

  private _postMessage(message: ExtensionToPanelMessage) {
    this._panel.webview.postMessage(message);
  }

  public dispose() {
    PlaygroundPanelProvider.panels.delete(this.playgroundId);
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // In monaco-vscode-api (browser environment), construct URLs directly
    const baseUri = this._extensionUri.toString().replace(/\/$/, ""); // Remove trailing slash
    const scriptUri = `${baseUri}/src/webview-dist/playground-panel.js`;
    const signalsUri = `${baseUri}/src/webview-dist/signals.module.js`;
    const styleUri = `${baseUri}/src/webview-dist/postgres-garden.css`;
    const codiconsUri = `${baseUri}/node_modules/@vscode/codicons/dist/codicon.css`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${codiconsUri}" rel="stylesheet" />
        <link href="${styleUri}" rel="stylesheet">
        <title>Playground Editor</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" nonce="${nonce}" src="${signalsUri}"></script>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
