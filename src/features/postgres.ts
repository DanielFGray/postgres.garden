import * as vscode from "vscode";
import { PGliteService } from "./pglite";
import {
  ExtensionHostKind,
  registerExtension,
} from "@codingame/monaco-vscode-api/extensions";
import { DatabaseExplorerProvider } from "./introspection.js";
import {
  PGLITE_RESET,
  PGLITE_EXECUTE,
  PGLITE_INTROSPECT,
  DATABASE_EXPLORER,
  DATABASE_MIGRATE,
  LATEST_POSTS,
  ERD_SHOW,
  SERVER_SYNC_COMMIT,
  WORKSPACE_DOWNLOAD,
} from "./constants.js";
import { SQLNotebookExecutionController } from "./notebook/controller.js";
import { SQLSerializer } from "./notebook/sql.js";
import { MarkdownSerializer } from "./notebook/markdown.js";
import { loadWorkspaceFromInitialData } from "./workspaceSwitcher";
import { ERDPanelProvider } from "./erd/ERDPanelProvider.js";
import { updateSchema } from "./lsp.js";
import { getCurrentPlaygroundId } from "../routes.js";

// Module-level subscriptions for HMR support
const subscriptions: vscode.Disposable[] = [];

// eslint-disable-next-line @typescript-eslint/unbound-method
const { getApi, registerFileUrl } = registerExtension(
  {
    name: "postgres.garden",
    publisher: "postgres.garden",
    description: "postgres.garden",
    version: "1.0.0",
    engines: { vscode: "*" },
    capabilities: { virtualWorkspaces: true },
    extensionKind: ["workspace"],
    contributes: {
      languages: [
        {
          id: "sql",
          extensions: [".sql", ".dsql"],
          aliases: ["PostgreSQL", "SQL", "sql"],
          configuration: "./language-configuration.json",
        },
      ],
      grammars: [
        {
          language: "sql",
          scopeName: "source.sql",
          path: "./syntaxes/sql.tmLanguage.json",
        },
      ],
      walkthroughs: [
        {
          id: "pg-playground-getting-started",
          title: "PostgreSQL Playground Getting Started",
          description:
            "Learn PostgreSQL with interactive examples and get started with your first playground",
          steps: [
            {
              id: "choose-example",
              title: "Choose Your Starting Example",
              description:
                "[Empty Playground](command:pg-playground.createEmpty)",
              media: {
                markdown: "media/examples-overview.md",
              },
              completionEvents: [
                "onCommand:pg-playground.loadExample",
                "onCommand:pg-playground.createEmpty",
              ],
            },
            {
              id: "run-query",
              title: "Run Your First Query",
              description:
                "Execute a query to see live results:\n\n[▶️ Run Current Query](command:pg-playground.runQuery)\n\nWatch the output panel to see your query results in real-time.",
              media: {
                image: "media/run-query.png",
                altText: "Running a PostgreSQL query",
              },
              completionEvents: ["onCommand:pg-playground.runQuery"],
            },
            {
              id: "explore-features",
              title: "Explore Advanced Features",
              description:
                "Discover powerful PostgreSQL playground features:\n\n• **Schema Introspection**: Explore database structure\n• **Query History**: Access previous queries\n• **Export Results**: Save query outputs\n• **Share Playgrounds**: Collaborate with others\n\n[📖 Open Documentation](command:vscode.open?https://docs.pg-playground.com)",
              media: {
                image: "media/features-overview.png",
                altText: "PostgreSQL playground features",
              },
            },
          ],
        },
      ],
      configuration: [
        {
          order: 22,
          title: "postgres.garden",
          properties: {
            "postgres.garden.introspection-tree.grouping": {
              title: "introspection tree grouping",

              type: "string",
              // scope: "window",
              enum: ["alphabetical", "grouped by type"],
              default: "grouped by type",
              description: "Grouping of the introspection tree.",
            },
          },
        },
      ],
      notebooks: [
        {
          type: "sql-notebook",
          displayName: "SQL Notebook",
          priority: "default",
          selector: [{ filenamePattern: "*.sql" }],
        },
        {
          type: "markdown-notebook",
          displayName: "Markdown Notebook",
          priority: "default",
          selector: [{ filenamePattern: "*.md" }],
        },
      ],
      notebookRenderer: [
        {
          id: "pg-playground-sql-renderer",
          entrypoint: "./renderer/index.js",
          displayName: "SQL Results Renderer",
          mimeTypes: ["application/vnd.pg-playground.sql-result+json"],
        },
      ],
      commands: [
        {
          command: PGLITE_RESET,
          title: "Reset database",
          icon: "$(trash)",
        },
        {
          command: PGLITE_EXECUTE,
          title: "Execute SQL",
          icon: "$(notebook-execute)",
        },
        {
          command: SERVER_SYNC_COMMIT,
          title: "Save",
          icon: "$(cloud-upload)",
        },
        {
          command: PGLITE_INTROSPECT,
          title: "Refresh introspection data",
          icon: "$(repo-sync)",
        },
        {
          command: DATABASE_MIGRATE,
          title: "Run migrations",
          icon: "$(run-all)",
        },
        {
          command: "github-login",
          title: "Login with GitHub",
          icon: "$(github)",
        },
        {
          command: LATEST_POSTS,
          title: "Latest Posts",
          icon: "$(clock)",
        },
        {
          command: ERD_SHOW,
          title: "Show ERD",
          icon: "$(type-hierarchy)",
        },
        {
          command: WORKSPACE_DOWNLOAD,
          title: "Download workspace",
          icon: "$(desktop-download)",
        },
      ],
      menus: {
        commandPalette: [
          {
            command: PGLITE_EXECUTE,
            when: "editorLangId == sql",
          },
        ],
        "view/title": [
          {
            command: ERD_SHOW,
            when: "view == databaseExplorer",
            group: "navigation",
          },
          {
            command: PGLITE_INTROSPECT,
            when: "view == databaseExplorer",
            group: "navigation",
          },
        ],
        "editor/title": [
          // { command: "sql.format", group: "1_run" },
          { command: DATABASE_MIGRATE, group: "1_run" },
          { command: SERVER_SYNC_COMMIT, group: "1_run" },
          { command: ERD_SHOW, group: "1_run" },
          { command: WORKSPACE_DOWNLOAD, group: "1_run" },
          { command: PGLITE_RESET, group: "5_close" },
        ],
        "notebook/cell/execute": [
          {
            command: PGLITE_EXECUTE,
            group: "navigation",
            when: "editorLangId == sql",
          },
        ],
      },
      views: {
        explorer: [
          { id: DATABASE_EXPLORER, name: "Database", visibility: "visible" },
          // { id: PLAYGROUND_INFO, name: "Playground", type: "webview" },
        ],
      },
      viewsWelcome: [
        {
          view: "workbench.explorer.emptyView",
          contents:
            "Welcome to PostgreSQL Playground! 🐘\n\nGet started with interactive PostgreSQL examples:\n\n[🆕 Create Empty Playground](command:pg-playground.createEmpty)\n\n[📚 Open Getting Started Guide](command:workbench.action.openWalkthrough?pg-playground-getting-started)",
        },
        {
          view: DATABASE_EXPLORER,
          contents: "Run some commands to see your schema",
        },
      ],
    },
  },
  ExtensionHostKind.LocalProcess,
);

// Register renderer bundle (both with and without .js)
// CSS is inlined into the JS bundle and injected into the Shadow DOM at runtime.
registerFileUrl(
  "renderer/index",
  new URL(
    "./notebook/renderer-dist/sql-renderer.js",
    import.meta.url,
  ).toString(),
);

registerFileUrl(
  "renderer/index.js",
  new URL(
    "./notebook/renderer-dist/sql-renderer.js",
    import.meta.url,
  ).toString(),
);

// PostgreSQL language support (replaces @codingame/monaco-vscode-sql-default-extension)
registerFileUrl(
  "./language-configuration.json",
  new URL("./pgsql/language-configuration.json", import.meta.url).toString(),
);

registerFileUrl(
  "./syntaxes/sql.tmLanguage.json",
  new URL("./pgsql/sql.tmLanguage.json", import.meta.url).toString(),
);

void getApi().then(async (vscode) => {
  console.log(
    "[TEST READY] VSCode API initialized, setting window.vscode and window.vscodeReady",
  );
  window.vscode = vscode;
  window.vscodeReady = Promise.resolve(vscode);
  console.log("[TEST READY] window.vscodeReady is now set");

  // Clear old subscriptions on HMR reload
  // Wait for async disposals to complete before creating new services
  await Promise.all(
    subscriptions.map(async (d) => {
      if (typeof d.dispose === "function") {
        await d.dispose();
      }
    }),
  );
  subscriptions.length = 0;

  // Register notebook serializers FIRST - before loading workspace
  // This ensures .md and .sql files can be opened as notebooks
  subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "markdown-notebook",
      new MarkdownSerializer(),
    ),
  );
  const controller1 = new SQLNotebookExecutionController("markdown-notebook");
  subscriptions.push(controller1);

  subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "sql-notebook",
      new SQLSerializer(),
    ),
  );
  const controller2 = new SQLNotebookExecutionController("sql-notebook");
  subscriptions.push(controller2);

  // Create PGlite service instance
  const pgliteService = new PGliteService();

  // Add to subscriptions for proper cleanup
  subscriptions.push({
    dispose: () => pgliteService.dispose(),
  });

  // Restore workspace from server (if available)
  // Only restore for local workspaces (not remote)
  // NOTE: This must happen AFTER notebook serializers are registered
  await loadWorkspaceFromInitialData();

  const pgliteOutputChannel = vscode.window.createOutputChannel("PGlite");
  subscriptions.push(pgliteOutputChannel);

  // Initialize PGlite and show version info
  void new Promise<void>((res) => {
    pgliteOutputChannel.appendLine("starting postgres");
    // pgliteOutputChannel.show();
    pgliteService
      .query<{ version: string }>("select version()")
      .then((result) => {
        pgliteOutputChannel.appendLine(result.rows[0]?.version ?? "");
        pgliteOutputChannel.appendLine("Powered by @electric-sql/pglite");
      })
      .then(res)
      .catch(console.error);
  });

  const queryOpts = {};

  subscriptions.push(
    vscode.commands.registerCommand(
      DATABASE_MIGRATE,
      async function migrate(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const uris = (
          await findFiles(folder.uri, ([f]) => /\/\d+[^/]+\.sql$/.test(f.path))
        ).sort((a, b) => a.path.localeCompare(b.path));
        if (!uris.length) {
          await vscode.window.showInformationMessage(
            "No migration files detected",
          );
          return;
        }
        const files = await Promise.all(
          uris.map(async (f) => {
            const raw = await vscode.workspace.fs.readFile(f);
            return new TextDecoder().decode(raw);
          }),
        );
        for (const sql of files) {
          await vscode.commands.executeCommand(PGLITE_EXECUTE, sql);
        }
        vscode.commands.executeCommand(PGLITE_INTROSPECT);
        vscode.window.showInformationMessage(
          `finished ${uris.length} migrations`,
        );
      },
    ),
  );

  subscriptions.push(
    vscode.commands.registerCommand(
      PGLITE_EXECUTE,
      async function exec(sql: string) {
        try {
          const result = await pgliteService.exec(sql, queryOpts);
          result.forEach((stmt) => {
            pgliteOutputChannel.appendLine(stmt.statement);
          });
          if (
            result.some((r) =>
              ["CREATE", "ALTER", "DROP"].some((stmt) =>
                r.statement.startsWith(stmt),
              ),
            )
          ) {
            vscode.commands.executeCommand(PGLITE_INTROSPECT);
          }
          return result;
        } catch (error) {
          pgliteOutputChannel.appendLine(
            `Error: ${(error as Error)?.message ?? JSON.stringify(error)}`,
          );
          return [{ error, statement: sql }];
        }
      },
    ),
  );

  subscriptions.push(
    vscode.commands.registerCommand(PGLITE_RESET, async function reset() {
      pgliteOutputChannel.replace("restarting postgres\n");
      await pgliteService.reset();
      vscode.commands.executeCommand(PGLITE_INTROSPECT);
      const { rows } = await pgliteService.query<{ version: string }>(
        "select version()",
      );
      pgliteOutputChannel.appendLine(
        rows[0]?.version ?? "failed fetching version",
      );
    }),
  );

  const dbExplorer = new DatabaseExplorerProvider();
  const dbTreeView = vscode.window.createTreeView(DATABASE_EXPLORER, {
    treeDataProvider: dbExplorer,
  });
  subscriptions.push(dbTreeView);
  const [refreshIntrospection] = throttle(async () => {
    await dbExplorer.refresh();
    if (dbExplorer.introspection) {
      updateSchema(dbExplorer.introspection);
    }
  }, 50);
  subscriptions.push(
    vscode.commands.registerCommand(PGLITE_INTROSPECT, () => {
      void refreshIntrospection();
      dbTreeView.reveal(undefined, { expand: true });
      ERDPanelProvider.refresh();
    }),
  );

  // Download workspace as zip
  subscriptions.push(
    vscode.commands.registerCommand(
      WORKSPACE_DOWNLOAD,
      async function downloadWorkspace() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;

        const uris = await findFiles(folder.uri);
        if (uris.length === 0) {
          void vscode.window.showInformationMessage("No files to download.");
          return;
        }

        const entries = await Promise.all(
          uris.map(async (uri) => {
            const content = await vscode.workspace.fs.readFile(uri);
            const relativePath = uri.path.replace(/^\/workspace\//, "");
            return { name: relativePath, input: content };
          }),
        );

        const { downloadZip } = await import("client-zip");
        const blob = await downloadZip(entries).blob();
        const name = getCurrentPlaygroundId() ?? "workspace";
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      },
    ),
  );

  // ERD panel
  subscriptions.push(
    vscode.commands.registerCommand(ERD_SHOW, () => {
      ERDPanelProvider.createOrShow(
        vscode.Uri.parse(window.location.origin),
        pgliteService,
      );
    }),
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic constraint requires any for proper variance
function throttle<F extends (...args: any[]) => any>(
  func: F,
  wait: number,
): [throttled: (...args: Parameters<F>) => void, cancel: () => void] {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<F> | null = null;

  const throttled = (...args: Parameters<F>) => {
    lastArgs = args;
    if (timeout === null) {
      func(...lastArgs);
      lastArgs = null;
      timeout = setTimeout(() => {
        timeout = null;
        if (lastArgs) {
          throttled(...lastArgs);
        }
      }, wait);
    }
  };

  const cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastArgs = null;
  };

  return [throttled, cancel];
}

async function findFiles(
  dir: vscode.Uri,
  predicate?: (x: [f: vscode.Uri, type: vscode.FileType]) => boolean,
): Promise<vscode.Uri[]> {
  const readdir = await vscode.workspace.fs.readDirectory(dir);
  const files = [];
  for (const [file, fileType] of readdir) {
    const uri = vscode.Uri.joinPath(dir, file);
    if (predicate && !predicate([uri, fileType])) continue;
    if (fileType & vscode.FileType.Directory) {
      const getDir = await findFiles(uri, predicate);
      files.push(...getDir);
    } else {
      files.push(uri);
    }
  }
  return files;
}

// HMR support - dispose resources on hot reload
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    console.log("[HMR] Disposing postgres extension resources");
    // Wait for all disposals to complete
    await Promise.all(
      subscriptions.map(async (d) => {
        await d.dispose();
      }),
    );
    subscriptions.length = 0;
  });
}
