/**
 * Playground Browser Panel
 * Shows the playground list in a webview panel (like a welcome page)
 */

import * as vscode from "vscode";
import { Effect, Match } from "effect";
import * as S from "effect/Schema";
import { navigateTo } from "../../../shared/navigation";
import { buildWebviewHtml, handleRelayRequest } from "../../webview/hostBridge";
import { PlaygroundListMessage } from "../types";

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
      (message) => {
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

  private _handleMessage(raw: unknown) {
    return S.decodeUnknownEffect(PlaygroundListMessage)(raw).pipe(
      Effect.flatMap((message) =>
        Match.value(message).pipe(
          Match.discriminator("type")("api-relay-request", (request) =>
            handleRelayRequest((reply) => {
              void this._panel.webview.postMessage(reply);
            }, request),
          ),
          Match.discriminator("type")("open-playground", ({ hash }) =>
            Effect.gen(function* () {
              const url = `/playgrounds/${hash}`;
              yield* Effect.log("[PlaygroundBrowser] Navigating to playground:", url);
              navigateTo(url);
            }),
          ),
          Match.exhaustive,
        ),
      ),
      Effect.catch((error) => Effect.logError("[PlaygroundBrowser] Message failed", error)),
    );
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
      scripts: ["src/webview-dist/playground-view.js"],
    });
  }
}
