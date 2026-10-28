import * as vscode from "vscode";
import { Effect, Match } from "effect";
import * as S from "effect/Schema";
import { AuthWebviewMessage, type AuthPanelCallbacks } from "./types";
import { buildWebviewHtml, handleRelayRequest } from "../webview/hostBridge";

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
      (message) => void Effect.runPromise(this._handleMessage(message)),
      null,
      this._disposables,
    );
  }

  private _handleMessage(raw: unknown) {
    return S.decodeUnknownEffect(AuthWebviewMessage)(raw).pipe(
      Effect.flatMap((message) =>
        Match.value(message).pipe(
          Match.discriminator("type")("initialized", () => Effect.sync(() => this._sendInitView())),
          Match.discriminator("type")("api-relay-request", (request) =>
            handleRelayRequest((response) => {
              void this._panel.webview.postMessage(response);
            }, request),
          ),
          Match.discriminator("type")("github-signin", () =>
            Effect.sync(() => this._handleGitHubSignIn()),
          ),
          Match.discriminator("type")("auth-complete", ({ username }) =>
            Effect.sync(() => {
              this._authCompleted = true;
              AuthPanelProvider._callbacks?.onAuth(username);
              this._panel.dispose();
            }),
          ),
          Match.exhaustive,
        ),
      ),
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning("auth panel: dropped an undecodable webview message", error),
      ),
    );
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
    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Sign In",
      styles: [
        "src/webview-dist/postgres-garden.css",
        "node_modules/@vscode/codicons/dist/codicon.css",
      ],
      scripts: ["src/webview-dist/auth-panel.js"],
      allowRemoteImages: true,
    });
  }
}
