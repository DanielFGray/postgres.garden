/**
 * Playground Browser Panel
 * Shows the playground list in a webview panel (like a welcome page)
 */

import * as vscode from "vscode";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Layer } from "effect";
import { navigateTo } from "fibrae/router";
import { getNetworkState } from "../../network";
import { generateNonce } from "../../../utils/nonce";
import { applyTelemetryHeaders, type RequestTelemetryContext } from "../../webview/requestTelemetry";

const WebviewHttpClientLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
);

interface RequestMessage {
  type: "request";
  id: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  telemetry?: RequestTelemetryContext;
}

interface CommandMessage {
  type: "command";
  command: string;
  data?: Record<string, unknown>;
}

type WebviewMessage = RequestMessage | CommandMessage;

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

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Set initial HTML
    this._panel.webview.html = this.getHtmlForWebview(this._panel.webview);

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void this._handleMessage(message);
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

  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "request":
        await this._handleApiRequest(
          message.id,
          message.endpoint,
          message.method,
          message.body,
          message.telemetry,
        );
        break;

      case "command":
        this._handleCommand(message.command, message.data);
        break;
    }
  }

  private _handleCommand(command: string, data?: Record<string, unknown>) {
    switch (command) {
      case "openPlayground": {
        const hash = data?.hash;
        if (typeof hash !== "string") return;
        const url = `/playgrounds/${hash}`;
        console.log("[PlaygroundBrowser] Navigating to playground:", url);
        navigateTo(url);
        break;
      }
    }
  }

  private async _handleApiRequest(
    id: string,
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
    telemetry?: RequestTelemetryContext,
  ) {
    const networkState = getNetworkState();

    // Block writes when offline
    if (networkState !== "online" && method !== "GET") {
      this._panel.webview.postMessage({ type: "offline" });
      return;
    }

    // For reads when offline, still try (may have cached data)
    if (networkState === "offline") {
      this._panel.webview.postMessage({
        type: "error",
        id,
        error: { code: "OFFLINE", message: "You're offline" },
      });
      return;
    }

    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      applyTelemetryHeaders(headers, telemetry);

      const { response, responseBody } = await Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient;
        const requestWithoutBody = HttpClientRequest.make(method)(window.location.origin + endpoint).pipe(
          HttpClientRequest.setHeaders(headers),
        );
        const request = body !== undefined
          ? HttpClientRequest.bodyUnsafeJson(requestWithoutBody, body)
          : requestWithoutBody;

        const response = yield* client.execute(request);
        const responseBody: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
        return { response, responseBody };
      }).pipe(
        Effect.provide(WebviewHttpClientLayer),
        Effect.runPromise,
      );

      if (response.status < 200 || response.status >= 300) {
        this._panel.webview.postMessage({
          type: "error",
          id,
          error: {
            code: String(response.status),
            message: JSON.stringify(responseBody),
          },
        });
        return;
      }

      this._panel.webview.postMessage({ type: "data", id, data: responseBody });
    } catch (err) {
      this._panel.webview.postMessage({
        type: "error",
        id,
        error: {
          code: "NETWORK",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const baseUri = this._extensionUri.toString().replace(/\/$/, "");
    const scriptUri = `${baseUri}/src/webview-dist/playground-view.js`;
    const signalsUri = `${baseUri}/src/webview-dist/signals.module.js`;
    const styleUri = `${baseUri}/src/webview-dist/postgres-garden.css`;
    const codiconsUri = `${baseUri}/node_modules/@vscode/codicons/dist/codicon.css`;

    const nonce = generateNonce();

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
