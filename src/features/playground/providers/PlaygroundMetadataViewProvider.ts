/**
 * Sidebar WebviewView provider for Playground Metadata
 * Replaces the old TreeDataProvider with an editable form
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

interface ForkCommandMessage {
  type: "command";
  command: "fork";
  data: { readonly hash: string };
}

interface ToggleStarCommandMessage {
  type: "command";
  command: "toggleStar";
}

type WebviewMessage = RequestMessage | ForkCommandMessage | ToggleStarCommandMessage;

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
      void Effect.runPromise(this._handleMessage(message as WebviewMessage));
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

  private _handleMessage(message: WebviewMessage): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (message.type) {
        case "request":
          yield* handleWebviewApiRequest((msg) => this._view?.webview.postMessage(msg), message);
          break;

        case "command":
          this._handleCommand(message);
          break;
      }
    });
  }

  private _handleCommand(message: ForkCommandMessage | ToggleStarCommandMessage) {
    switch (message.command) {
      case "fork": {
        const url = `/playgrounds/${message.data.hash}`;
        navigateTo(url);
        break;
      }
      case "toggleStar": {
        void vscode.commands.executeCommand("playground.toggleStar");
        break;
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Playground Info",
      styles: [
        "node_modules/@vscode/codicons/dist/codicon.css",
        "src/webview-dist/postgres-garden.css",
      ],
      scripts: ["src/webview-dist/signals.module.js", "src/webview-dist/playground-panel.js"],
    });
  }
}
