import * as vscode from "vscode";
import { Effect } from "effect";
import type { AuthWebviewMessage, AuthPanelCallbacks } from "./types";
import { buildWebviewHtml, handleWebviewApiRequest } from "../webview/hostBridge";

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
        void Effect.runPromise(this._handleMessage(message));
      },
      null,
      this._disposables,
    );
  }

  private _handleMessage(message: AuthWebviewMessage): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (message.type) {
        case "initialized":
          this._sendInitView();
          break;

        case "request":
          yield* handleWebviewApiRequest((msg) => this._panel.webview.postMessage(msg), message);
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
    });
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
    const serverOrigin = this._extensionUri.toString().replace(/\/$/, "");

    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Sign In",
      styles: [
        "src/webview-dist/postgres-garden.css",
        "node_modules/@vscode/codicons/dist/codicon.css",
      ],
      scripts: ["src/webview-dist/auth-panel.js"],
      connectSrc: serverOrigin,
      allowRemoteImages: true,
      extraHeadHtml: `<meta name="pg-garden-server-origin" content="${serverOrigin}">`,
    });
  }
}
