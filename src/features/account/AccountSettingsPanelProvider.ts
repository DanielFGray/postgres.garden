import * as vscode from "vscode";

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
          vscode.Uri.joinPath(extensionUri, "src", "features", "account", "panel-dist"),
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
    const scriptUri = `${baseUri}/src/features/account/panel-dist/account-settings-panel.js`;
    const codiconsUri = `${baseUri}/node_modules/@vscode/codicons/dist/codicon.css`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ${baseUri} https: http:;">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Account Settings</title>
      </head>
      <body>
        <div id="root" data-codicons="${codiconsUri}" data-api-base="${baseUri}"></div>
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
