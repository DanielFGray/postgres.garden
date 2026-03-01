/**
 * Sidebar WebviewView provider for Playground Metadata
 * Replaces the old TreeDataProvider with an editable form
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

export class PlaygroundMetadataViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "playground.metadata";

  private _view?: vscode.WebviewView;
  private _currentPlaygroundId: string | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage | { type: "initialized" }) => {
      if (message.type === "initialized") {
        // Webview JS is ready — send current playground ID if we have one
        if (this._currentPlaygroundId) {
          this._postLoadPlayground(this._currentPlaygroundId);
        }
        return;
      }
      void this._handleMessage(message as WebviewMessage);
    });
  }

  refresh(playgroundId: string | null) {
    this._currentPlaygroundId = playgroundId;

    if (!this._view) return;

    if (!playgroundId) {
      this._view.webview.postMessage({ type: "clearPlayground" });
      return;
    }

    this._postLoadPlayground(playgroundId);
  }

  triggerSave() {
    this._view?.webview.postMessage({ type: "triggerSave" });
  }

  private _postLoadPlayground(playgroundId: string) {
    // Tell webview to load this playground via the API bridge
    this._view?.webview.postMessage({
      type: "setPlaygroundId",
      data: { playgroundId },
    });
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
      case "fork": {
        const hash = data?.hash;
        if (typeof hash !== "string") return;
        const url = `/playgrounds/${hash}`;
        navigateTo(url);
        break;
      }
      case "toggleStar": {
        void vscode.commands.executeCommand("playground.toggleStar");
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
    if (!this._view) return;

    const networkState = getNetworkState();

    if (networkState !== "online" && method !== "GET") {
      this._view.webview.postMessage({ type: "offline" });
      return;
    }

    if (networkState === "offline") {
      this._view.webview.postMessage({
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

      const { response, responseBody } = await Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const requestWithoutBody = HttpClientRequest.make(method)(
          window.location.origin + endpoint,
        ).pipe(HttpClientRequest.setHeaders(headers));
        const request =
          body !== undefined
            ? HttpClientRequest.bodyUnsafeJson(requestWithoutBody, body)
            : requestWithoutBody;

        const response = yield* client.execute(request);
        const responseBody: unknown = yield* response.json.pipe(
          Effect.orElseSucceed(() => null),
        );
        return { response, responseBody };
      }).pipe(Effect.provide(WebviewHttpClientLayer), Effect.runPromise);

      if (response.status < 200 || response.status >= 300) {
        this._view.webview.postMessage({
          type: "error",
          id,
          error: {
            code: String(response.status),
            message: JSON.stringify(responseBody),
          },
        });
        return;
      }

      this._view.webview.postMessage({ type: "data", id, data: responseBody });
    } catch (err) {
      this._view.webview.postMessage({
        type: "error",
        id,
        error: {
          code: "NETWORK",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const baseUri = this._extensionUri.toString().replace(/\/$/, "");
    const scriptUri = `${baseUri}/src/webview-dist/playground-panel.js`;
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
        <title>Playground Info</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" nonce="${nonce}" src="${signalsUri}"></script>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}
