import * as vscode from "vscode";
import { api } from "../../api-client";
import { getNetworkState } from "../network";
import type { WebviewMessage } from "./types";

export class AccountSettingsPanelProvider {
  public static readonly viewType = "accountSettings.editor";
  private static instance: AccountSettingsPanelProvider | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    if (AccountSettingsPanelProvider.instance) {
      AccountSettingsPanelProvider.instance._panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AccountSettingsPanelProvider.viewType,
      "Account Settings",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "src", "webview-dist"),
          vscode.Uri.joinPath(extensionUri, "node_modules", "@vscode", "codicons", "dist"),
        ],
        retainContextWhenHidden: true,
      },
    );

    AccountSettingsPanelProvider.instance = new AccountSettingsPanelProvider(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._panel.iconPath = new vscode.ThemeIcon("account");

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => { void this._handleMessage(message); },
      null,
      this._disposables,
    );
  }

  private async _handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "initialized":
        break;

      case "request":
        await this._handleApiRequest(message.id, message.endpoint, message.method, message.body);
        break;
    }
  }

  private async _handleApiRequest(id: string, endpoint: string, method: string, body?: unknown) {
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
      const options: Record<string, unknown> = { method };
      if (body !== undefined) {
        options.body = body;
      }

      const { data, error } = await api(endpoint as Parameters<typeof api>[0], options as Parameters<typeof api>[1]);

      if (error) {
        this._panel.webview.postMessage({
          type: "error",
          id,
          error: {
            code: String((error as { status?: number }).status ?? "UNKNOWN"),
            message: JSON.stringify((error as { value?: unknown }).value),
          },
        });
        return;
      }

      this._panel.webview.postMessage({ type: "data", id, data });
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

  public dispose() {
    AccountSettingsPanelProvider.instance = undefined;
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
    const scriptUri = `${baseUri}/src/webview-dist/account-settings.js`;
    const codiconsUri = `${baseUri}/node_modules/@vscode/codicons/dist/codicon.css`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${codiconsUri}" rel="stylesheet" />
        <title>Account Settings</title>
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
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
