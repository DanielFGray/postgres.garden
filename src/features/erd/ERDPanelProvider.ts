import * as vscode from "vscode";
import type { PGliteService } from "../pglite.js";
import { getMermaidERD } from "./query.js";

interface ExtensionToERDMessage {
  type: "load" | "error";
  data?: {
    mermaidCode?: string;
    message?: string;
  };
}

interface ERDToExtensionMessage {
  type: "initialized" | "refresh";
}

export class ERDPanelProvider {
  public static readonly viewType = "erdViewer.panel";
  private static panel: ERDPanelProvider | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _pgliteService: PGliteService;

  private static _refreshTimeout: ReturnType<typeof setTimeout> | undefined;

  public static refresh() {
    clearTimeout(ERDPanelProvider._refreshTimeout);
    ERDPanelProvider._refreshTimeout = setTimeout(() => {
      if (ERDPanelProvider.panel) {
        void ERDPanelProvider.panel._loadERD();
      }
    }, 300);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    pgliteService: PGliteService,
  ) {
    // Check if we already have a panel
    if (ERDPanelProvider.panel) {
      ERDPanelProvider.panel._panel.reveal();
      return;
    }

    // Create new panel in a split
    const panel = vscode.window.createWebviewPanel(
      ERDPanelProvider.viewType,
      "Entity Relationship Diagram",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(
            extensionUri,
            "src",
            "webview-dist",
          ),
        ],
        retainContextWhenHidden: true,
      },
    );

    const provider = new ERDPanelProvider(panel, extensionUri, pgliteService);
    ERDPanelProvider.panel = provider;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    pgliteService: PGliteService,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._pgliteService = pgliteService;

    // Set initial HTML
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Load ERD data
    void this._loadERD();

    // Handle dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: ERDToExtensionMessage) => this._handleMessage(message),
      null,
      this._disposables,
    );
  }

  private async _loadERD() {
    try {
      const mermaidCode = await getMermaidERD(this._pgliteService);
      this._postMessage({
        type: "load",
        data: { mermaidCode },
      });
    } catch (error) {
      console.error("Failed to load ERD:", error);
      this._postMessage({
        type: "error",
        data: {
          message: `Failed to load schema: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  private async _handleMessage(message: ERDToExtensionMessage) {
    switch (message.type) {
      case "initialized":
        // Webview is ready, data will be sent automatically
        break;
      case "refresh":
        await this._loadERD();
        break;
    }
  }

  private _postMessage(message: ExtensionToERDMessage) {
    this._panel.webview.postMessage(message);
  }

  public dispose() {
    ERDPanelProvider.panel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

   private _getHtmlForWebview(webview: vscode.Webview) {
    const baseUri = this._extensionUri.toString().replace(/\/$/, "");
    const scriptUri = `${baseUri}/src/webview-dist/erd-viewer.js`;
    const styleUri = `${baseUri}/src/webview-dist/postgres-garden.css`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <title>Entity Relationship Diagram</title>
      </head>
      <body>
        <div id="root"></div>
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
