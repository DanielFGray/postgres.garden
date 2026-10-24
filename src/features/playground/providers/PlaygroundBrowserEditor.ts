/**
 * Playground Browser Panel
 * Shows the playground list in a webview panel (like a welcome page)
 */

import * as vscode from "vscode";
import { Effect } from "effect";
import { navigateTo } from "../../../shared/navigation";
import type { RequestTelemetryContext } from "../../webview/requestTelemetry";
import { buildWebviewHtml, handleWebviewApiRequest } from "../../webview/hostBridge";
import type { WebviewValue } from "../../webview/apiBridge";

interface RequestMessage {
  type: "request";
  id: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: WebviewValue;
  telemetry?: RequestTelemetryContext;
}

interface OpenPlaygroundCommand {
  type: "command";
  command: "openPlayground";
  data: { readonly hash: string };
}

type WebviewMessage = RequestMessage | OpenPlaygroundCommand;

export class PlaygroundBrowserPanel {
  public static currentPanel: PlaygroundBrowserPanel | undefined;
  public static readonly viewType = "playgroundBrowser.panel";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

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

    PlaygroundBrowserPanel.currentPanel = new PlaygroundBrowserPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Set initial HTML
    this._panel.webview.html = this.getHtmlForWebview(this._panel.webview);

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void Effect.runPromise(this._handleMessage(message));
      },
      null,
      this._disposables,
    );
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

  private _handleMessage(message: WebviewMessage): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (message.type) {
        case "request":
          yield* handleWebviewApiRequest((msg) => this._panel.webview.postMessage(msg), message);
          break;

        case "command":
          yield* this._handleCommand(message);
          break;
      }
    });
  }

  private _handleCommand(command: OpenPlaygroundCommand): Effect.Effect<void> {
    return Effect.gen(function* () {
      switch (command.command) {
        case "openPlayground": {
          const url = `/playgrounds/${command.data.hash}`;
          yield* Effect.log("[PlaygroundBrowser] Navigating to playground:", url);
          navigateTo(url);
          break;
        }
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Playground Browser",
      styles: [
        "node_modules/@vscode/codicons/dist/codicon.css",
        "src/webview-dist/postgres-garden.css",
      ],
      scripts: ["src/webview-dist/signals.module.js", "src/webview-dist/playground-view.js"],
    });
  }
}
