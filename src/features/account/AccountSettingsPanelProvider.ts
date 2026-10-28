import * as vscode from "vscode";
import { Effect, Match } from "effect";
import * as S from "effect/Schema";
import { InitState, AccountWebviewMessage } from "./types";
import { buildWebviewHtml, handleRelayRequest } from "../webview/hostBridge";

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
      (message) => {
        void Effect.runPromise(
          S.decodeUnknownEffect(AccountWebviewMessage)(message).pipe(
            Effect.flatMap((decoded) => this._handleMessage(decoded)),
            Effect.catchCause(Effect.logError),
          ),
        );
      },
      null,
      this._disposables,
    );
  }

  private _handleMessage(message: typeof AccountWebviewMessage.Type) {
    return Effect.gen({ self: this }, function* () {
      yield* Match.value(message).pipe(
        Match.discriminator("type")("initialized", () => this._postInitState(this._initState)),
        Match.discriminator("type")("account-deleted", () =>
          Effect.sync(() => {
            this.dispose();
            window.location.assign("/");
          }),
        ),
        Match.discriminator("type")("api-relay-request", (request) =>
          handleRelayRequest((reply) => {
            void this._panel.webview.postMessage(reply);
          }, request),
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Sends the section and deletion token the panel was opened with. The
   * caller passes a plain section name, so it is decoded here, once.
   */
  private _postInitState(state?: AccountSettingsInitState): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!state) return;
      const message = yield* S.decodeUnknownEffect(InitState)({
        type: "init-state",
        ...state,
      });
      const encoded = yield* S.encodeEffect(InitState)(message);
      yield* Effect.promise(() => this._panel.webview.postMessage(encoded));
      this._initState = undefined;
    }).pipe(Effect.catchCause(Effect.logError));
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
