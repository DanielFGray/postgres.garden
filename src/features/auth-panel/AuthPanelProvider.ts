import * as vscode from "vscode";
import { getNetworkState } from "../network";
import type { AuthWebviewMessage, AuthPanelCallbacks } from "./types";

export class AuthPanelProvider {
  public static readonly viewType = "authPanel.editor";
  private static instance: AuthPanelProvider | undefined;
  private static _callbacks: AuthPanelCallbacks | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _authCompleted = false;

  /**
   * The initial view and params to send to the webview once it initializes.
   * Used for deep-linking into reset-password or verify-email views.
   */
  private _initView: string | undefined;
  private _initParams: Record<string, string> | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    callbacks?: AuthPanelCallbacks,
    initView?: string,
    initParams?: Record<string, string>,
  ) {
    AuthPanelProvider._callbacks = callbacks;

    if (AuthPanelProvider.instance) {
      AuthPanelProvider.instance._panel.reveal();
      // Update init view if provided
      if (initView) {
        AuthPanelProvider.instance._initView = initView;
        AuthPanelProvider.instance._initParams = initParams;
        AuthPanelProvider.instance._sendInitView();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AuthPanelProvider.viewType,
      "Sign In",
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

    const instance = new AuthPanelProvider(panel, extensionUri);
    instance._initView = initView;
    instance._initParams = initParams;
    AuthPanelProvider.instance = instance;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._panel.iconPath = new vscode.ThemeIcon("sign-in");

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message: AuthWebviewMessage) => {
        void this._handleMessage(message);
      },
      null,
      this._disposables,
    );
  }

  private async _handleMessage(message: AuthWebviewMessage) {
    switch (message.type) {
      case "initialized":
        this._sendInitView();
        break;

      case "request":
        await this._handleApiRequest(message.id, message.endpoint, message.method, message.body);
        break;

      case "github-signin":
        this._handleGitHubSignIn();
        break;

      case "auth-complete":
        this._authCompleted = true;
        AuthPanelProvider._callbacks?.onAuth(message.username);
        this._panel.dispose();
        break;
    }
  }

  private _sendInitView() {
    if (this._initView) {
      void this._panel.webview.postMessage({
        type: "init-view",
        view: this._initView,
        params: this._initParams,
      });
    }
  }

  private _handleGitHubSignIn() {
    AuthPanelProvider._callbacks?.onGitHubSignIn();
  }

  /**
   * Called by the auth provider when GitHub OAuth completes successfully.
   */
  public static notifyGitHubComplete(username: string) {
    if (AuthPanelProvider.instance) {
      AuthPanelProvider.instance._authCompleted = true;
      void AuthPanelProvider.instance._panel.webview.postMessage({
        type: "github-complete",
        username,
      });
    }
  }

  /**
   * Called by the auth provider when GitHub OAuth fails.
   */
  public static notifyGitHubError(message: string) {
    if (AuthPanelProvider.instance) {
      void AuthPanelProvider.instance._panel.webview.postMessage({
        type: "github-error",
        message,
      });
    }
  }

  private async _handleApiRequest(id: string, endpoint: string, method: string, body?: unknown) {
    const networkState = getNetworkState();

    if (networkState !== "online" && method !== "GET") {
      this._panel.webview.postMessage({ type: "offline" });
      return;
    }

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

      const response = await fetch(window.location.origin + endpoint, {
        method,
        credentials: "include",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const responseBody: unknown = await response.json().catch(() => null);

      if (!response.ok) {
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

  public dispose() {
    if (!this._authCompleted) {
      AuthPanelProvider._callbacks?.onCancel();
    }

    AuthPanelProvider.instance = undefined;
    AuthPanelProvider._callbacks = undefined;
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
    const scriptUri = `${baseUri}/src/webview-dist/auth-panel.js`;
    const styleUri = `${baseUri}/src/webview-dist/postgres-garden.css`;
    const codiconsUri = `${baseUri}/node_modules/@vscode/codicons/dist/codicon.css`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet" />
        <link href="${codiconsUri}" rel="stylesheet" />
        <title>Sign In</title>
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
