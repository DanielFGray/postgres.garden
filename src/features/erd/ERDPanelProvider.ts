import * as vscode from "vscode";
import { Effect, Fiber } from "effect";
import { getMermaidERD, type ERDQueryClient } from "./query.js";
import { buildWebviewHtml } from "../webview/hostBridge";

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
  private _pgliteService: ERDQueryClient;

  private static _refreshFiber: Fiber.Fiber<void, never> | undefined;

  public static refresh() {
    if (ERDPanelProvider._refreshFiber) {
      Effect.runFork(Fiber.interrupt(ERDPanelProvider._refreshFiber));
    }
    ERDPanelProvider._refreshFiber = Effect.runFork(
      Effect.sleep("300 millis").pipe(
        Effect.andThen(() =>
          ERDPanelProvider.panel ? ERDPanelProvider.panel._loadERD() : Effect.void,
        ),
      ),
    );
  }

  public static createOrShow(extensionUri: vscode.Uri, pgliteService: ERDQueryClient) {
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
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "src", "webview-dist")],
        retainContextWhenHidden: true,
      },
    );

    const provider = new ERDPanelProvider(panel, extensionUri, pgliteService);
    ERDPanelProvider.panel = provider;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    pgliteService: ERDQueryClient,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._pgliteService = pgliteService;

    // Set initial HTML
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Load ERD data
    Effect.runFork(this._loadERD());

    // Handle dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message: ERDToExtensionMessage) => Effect.runFork(this._handleMessage(message)),
      null,
      this._disposables,
    );
  }

  private _loadERD(): Effect.Effect<void> {
    return getMermaidERD(this._pgliteService).pipe(
      Effect.map((mermaidCode) => {
        this._postMessage({ type: "load", data: { mermaidCode } });
      }),
      Effect.catch((error) =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.logError("Failed to load ERD:", error);
          this._postMessage({
            type: "error",
            data: {
              message: `Failed to load schema: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
            },
          });
        }),
      ),
    );
  }

  private _handleMessage(message: ERDToExtensionMessage): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      switch (message.type) {
        case "initialized":
          // Webview is ready, data will be sent automatically
          break;
        case "refresh":
          yield* this._loadERD();
          break;
      }
    });
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
    return buildWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      title: "Entity Relationship Diagram",
      styles: ["src/webview-dist/postgres-garden.css"],
      scripts: ["src/webview-dist/erd-viewer.js"],
    });
  }
}
