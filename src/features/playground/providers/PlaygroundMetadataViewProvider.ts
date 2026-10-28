/**
 * Sidebar WebviewView provider for Playground Metadata
 * Replaces the old TreeDataProvider with an editable form
 */

import * as vscode from "vscode";
import { Effect, Match } from "effect";
import * as S from "effect/Schema";
import { navigateTo } from "../../../shared/navigation";
import { buildWebviewHtml, handleRelayRequest } from "../../webview/hostBridge";
import { PlaygroundPanelMessage } from "../types";

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

    webviewView.webview.onDidReceiveMessage((message) => {
      void Effect.runPromise(this._handleMessage(message));
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
    // The webview loads the playground itself, through its relayed API client.
    this._view?.webview.postMessage({
      type: "setPlaygroundId",
      data: { playgroundId },
    });
  }

  private _handleMessage(raw: unknown) {
    return S.decodeUnknownEffect(PlaygroundPanelMessage)(raw).pipe(
      Effect.flatMap((message) =>
        Match.value(message).pipe(
          Match.discriminator("type")("api-relay-request", (request) =>
            handleRelayRequest((reply) => {
              void this._view?.webview.postMessage(reply);
            }, request),
          ),
          // The webview script is ready: send the current playground, if there is one.
          Match.discriminator("type")("initialized", () =>
            Effect.sync(() => {
              if (this._currentPlaygroundId) this._postLoadPlayground(this._currentPlaygroundId);
            }),
          ),
          Match.discriminator("type")("open-playground", ({ hash }) =>
            Effect.sync(() => navigateTo(`/playgrounds/${hash}`)),
          ),
          Match.exhaustive,
        ),
      ),
      Effect.catch((error) => Effect.logError("[PlaygroundMetadata] Message failed", error)),
    );
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
