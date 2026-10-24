import * as vscode from "vscode";
import { Effect } from "effect";
import type { WebviewMessage } from "./types";
import { buildWebviewHtml, handleWebviewApiRequest } from "../webview/hostBridge";

type AccountSettingsInitState = {
  readonly section?: string;
  readonly deleteToken?: string;
};

export class AccountSettingsPanelProvider {
  public static readonly viewType = "accountSettings.editor";
  private static instance: AccountSettingsPanelProvider | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _initState?: AccountSettingsInitState;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, initState?: AccountSettingsInitState) {
    if (AccountSettingsPanelProvider.instance) {
      AccountSettingsPanelProvider.instance._panel.reveal();
      if (initState) {
        AccountSettingsPanelProvider.instance._initState = initState;
        void AccountSettingsPanelProvider.instance._postInitState(initState);
      }
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

    AccountSettingsPanelProvider.instance = new AccountSettingsPanelProvider(
      panel,
      extensionUri,
      initState,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    initState?: AccountSettingsInitState,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._initState = initState;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    this._panel.iconPath = new vscode.ThemeIcon("account");

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void Effect.runPromise(this._handleMessage(message));
      },
      null,
      this._disposables,
    );
  }

  private _handleMessage(message: WebviewMessage): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (message.type) {
        case "initialized":
          yield* this._postInitState(this._initState);
          break;

        case "account-deleted":
          this.dispose();
          window.location.assign("/");
          break;

        case "request":
          yield* handleWebviewApiRequest((msg) => this._panel.webview.postMessage(msg), message);
          break;
      }
    });
  }

  private _postInitState(state?: AccountSettingsInitState): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!state) return;
      yield* Effect.promise(() =>
        this._panel.webview.postMessage({
          type: "init-state",
          section: state.section,
          deleteToken: state.deleteToken,
        }),
      );
      this._initState = undefined;
    });
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
    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Account Settings",
      styles: [
        "src/webview-dist/postgres-garden.css",
        "node_modules/@vscode/codicons/dist/codicon.css",
      ],
      scripts: ["src/webview-dist/account-settings.js"],
      allowRemoteImages: true,
    });
  }
}
