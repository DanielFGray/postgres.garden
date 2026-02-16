/**
 * Playground Browser Panel
 * Shows the playground list in a webview panel (like a welcome page)
 */

import * as vscode from "vscode";
import type { ViewToExtensionMessage, ExtensionToViewMessage } from "../types";
import { PlaygroundService } from "../services/PlaygroundService";

export class PlaygroundBrowserPanel {
  public static currentPanel: PlaygroundBrowserPanel | undefined;
  public static readonly viewType = "playgroundBrowser.panel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private service: PlaygroundService;

  public static createOrShow(
    extensionUri: vscode.Uri,
    service?: PlaygroundService,
  ) {
    const column =
      vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

    // If we already have a panel, show it
    if (PlaygroundBrowserPanel.currentPanel) {
      PlaygroundBrowserPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      PlaygroundBrowserPanel.viewType,
      "Playgrounds",
      column,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: true,
      },
    );

    PlaygroundBrowserPanel.currentPanel = new PlaygroundBrowserPanel(
      panel,
      extensionUri,
      service,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    service?: PlaygroundService,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this.service = service || new PlaygroundService();

    // Set initial HTML
    this._panel.webview.html = this.getHtmlForWebview(this._panel.webview);

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (message: ViewToExtensionMessage) => {
        await this.handleMessage(message);
      },
      null,
      this._disposables,
    );

    // Load playgrounds
    void this.loadPlaygrounds();
  }

  public dispose() {
    PlaygroundBrowserPanel.currentPanel = undefined;

    // Clean up resources
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private async loadPlaygrounds() {
    console.log("[PlaygroundBrowser] Loading playgrounds...");
    try {
      const playgrounds = await this.service.listPlaygrounds();
      console.log("[PlaygroundBrowser] Loaded playgrounds:", playgrounds);
      this._panel.webview.postMessage({
        type: "playgroundsList",
        data: playgrounds,
      } as ExtensionToViewMessage);
    } catch (error) {
      console.error("[PlaygroundBrowser] Failed to load playgrounds:", error);
      this._panel.webview.postMessage({
        type: "error",
        data: { message: "Failed to load playgrounds" },
      } as ExtensionToViewMessage);
    }
  }

  private async handleMessage(message: ViewToExtensionMessage) {
    switch (message.type) {
      case "loadPlaygrounds":
        await this.loadPlaygrounds();
        break;

      case "createPlayground":
        await this.createPlayground(message.data);
        break;

      case "openPlayground":
        this.openPlayground(message.data.hash);
        break;

      case "deletePlayground":
        await this.deletePlayground(message.data.hash);
        break;

      case "forkPlayground":
        await this.forkPlayground(message.data.hash);
        break;
    }
  }

  private async createPlayground(data: { name: string; description?: string }) {
    try {
      const playground = await this.service.createPlayground({
        name: data.name,
        description: data.description,
        privacy: "private",
      });

      this._panel.webview.postMessage({
        type: "playgroundCreated",
      } as ExtensionToViewMessage);

      // Refresh the list
      await this.loadPlaygrounds();

      // Navigate to the new playground
      this.openPlayground(playground.hash);
    } catch (error) {
      console.error("[PlaygroundBrowser] Failed to create playground:", error);
      this._panel.webview.postMessage({
        type: "error",
        data: { message: "Failed to create playground" },
      } as ExtensionToViewMessage);
    }
  }

  private openPlayground(hash: string) {
    const url = `/playgrounds/${hash}`;
    console.log("[PlaygroundBrowser] Navigating to playground:", url);

    if (window.navigation) {
      window.navigation.navigate(url);
    } else {
      window.location.href = url;
    }
  }

  private async deletePlayground(hash: string) {
    try {
      await this.service.deletePlayground(hash);
      this._panel.webview.postMessage({
        type: "playgroundDeleted",
      } as ExtensionToViewMessage);
      await this.loadPlaygrounds();
    } catch (error) {
      console.error("[PlaygroundBrowser] Failed to delete playground:", error);
      this._panel.webview.postMessage({
        type: "error",
        data: { message: "Failed to delete playground" },
      } as ExtensionToViewMessage);
    }
  }

  private async forkPlayground(hash: string) {
    try {
      const fork = await this.service.forkPlayground(hash);
      this.openPlayground(fork.hash);
    } catch (error) {
      console.error("[PlaygroundBrowser] Failed to fork playground:", error);
      vscode.window.showErrorMessage("Failed to fork playground");
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const baseUri = this._extensionUri.toString().replace(/\/$/, "");
    const scriptUri = `${baseUri}/src/webview-dist/playground-view.js`;
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
        <title>Playground Browser</title>
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
