import * as vscode from "vscode";
import * as db from "./pglite";
import { IDisposable } from "monaco-editor";
import {
  registerCustomView,
  ViewContainerLocation,
} from "@codingame/monaco-vscode-workbench-service-override";
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions"
import getWorkspace from "~/example-small-schema";
import { fileSystemProvider } from "~/fsProvider";
import {
  FileType,
  RegisteredMemoryFile,
} from "@codingame/monaco-vscode-files-service-override";
import { DatabaseExplorerProvider } from "./introspection";
import { throttle } from "~lib/index";
import {
  PGLITE_RESET,
  PGLITE_EXECUTE,
  PGLITE_INTROSPECT,
  DATABASE_EXPLORER,
  DATABASE_MIGRATE,
  LATEST_POSTS,
  WORKSPACE_PREFIX,
  ERD_SHOW,
  ERD_UPDATE,
  // PLAYGROUND_INFO,
} from "./constants";
import { SQLNotebookExecutionController } from "./notebook/controller";
import { SQLSerializer } from "./notebook/sql";
import { MarkdownSerializer } from "./notebook/markdown";
import { getMermaidERD, mermaidRender } from "./erd";
import { api } from "~/api";

const { getApi } = registerExtension(
  {
    name: "pg-playground",
    publisher: "pg-playground",
    version: "1.0.0",
    engines: { vscode: "*" },
    capabilities: { virtualWorkspaces: true },
    extensionKind: ["workspace"],
    contributes: {
      configuration: [
        {
          order: 22,
          title: "Postgres Playground",
          properties: {
            "pg-playground.introspection-tree.grouping": {
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
          command: ERD_SHOW,
          title: "Show entity relationship diagram",
          icon: "$(type-hierarchy)",
        },
        {
          command: LATEST_POSTS,
          title: "Latest Posts",
          icon: "$(clock)",
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
          { command: PGLITE_EXECUTE, group: "1_run" },
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
          contents: `[see latest](command:${LATEST_POSTS})`,
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

// registerCustomView({
//   id: PLAYGROUND_INFO,
//   name: "Playground",
//   canToggleVisibility: false,
//   hideByDefault: false,
//   default: true,
//   collapsed: false,
//   order: 0,
//   location: ViewContainerLocation.Sidebar,
//   icon: new URL(
//     "../Visual_Studio_Code_1.35_icon.svg",
//     import.meta.url,
//   ).toString(),
//   renderBody(container: HTMLElement): vscode.Disposable {
//     container.style.display = "flex";
//     container.style.flexDirection = "column";
//     container.style.alignItems = "center";
//     // container.style.justifyContent = "center";
//     // container.style.height = "100%";

//     const playground = {};
//     const isOwner = me?.username === playground?.user?.username;

//     const fragment = document.createDocumentFragment();
//     if (playground?.id) {
//       const name = document.createElement("h1");
//       name.textContent = playground.name;
//       if (isOwner) {
//         name.contentEditable = "true";
//       }
//       fragment.appendChild(name);

//       const description = document.createElement("div");
//       description.textContent = playground.description;
//       fragment.appendChild(description);
//     }

//     container.replaceChildren(fragment);
//     return {
//       dispose() {},
//     };
//   },
//   actions: [
//     // isOwner ?
//     {
//       id: "save-all",
//       title: "Save Playground",
//       icon: "saveAll",
//       async run(accessor) {
//         vscode.commands.executeCommand(SAVE_WORKSPACE);
//         // void accessor.get(IDialogService).info("This is a custom view action button")
//       },
//     },
//     // :
//     {
//       id: "fork",
//       title: "fork",
//       icon: "gistFork",
//       async run(accessor) {
//         vscode.commands.executeCommand(SAVE_WORKSPACE);
//       },
//     },
//   ],
// });

void getApi().then(async vscode => {
  window.vscode = vscode;

  const subscriptions: IDisposable[] = [];

  subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "markdown-notebook",
      new MarkdownSerializer(),
    ),
  );
  new SQLNotebookExecutionController("markdown-notebook");

  subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      "sql-notebook",
      new SQLSerializer(),
    ),
  );

  new SQLNotebookExecutionController("sql-notebook");

  const { defaultLayout, files } = getWorkspace();

  Object.entries(files).forEach(([path, value]) =>
    fileSystemProvider.registerFile(
      new RegisteredMemoryFile(
        vscode.Uri.file(
          WORKSPACE_PREFIX.concat(path.startsWith("/") ? path : `/${path}`),
        ),
        value,
      ),
    ),
  );

  defaultLayout.editors.forEach(editor => {
    const uri = vscode.Uri.file(
      WORKSPACE_PREFIX.concat(
        editor.uri.startsWith("/") ? editor.uri : `/${editor.uri}`,
      ),
    );
    vscode.window.showNotebookDocument(uri);
  });

  const pgliteOutputChannel = vscode.window.createOutputChannel("PGlite");
  subscriptions.push(pgliteOutputChannel);
  new Promise<void>(res => {
    pgliteOutputChannel.appendLine("starting postgres");
    // pgliteOutputChannel.show();
    db.query<{ version: string }>("select version()")
      .then(version => {
        pgliteOutputChannel.appendLine(version.rows[0]?.version);
        pgliteOutputChannel.appendLine("Powered by @electric-sql/pglite");
      })
      .then(res)
      .catch(console.error);
  });

  const queryOpts = {};

  subscriptions.push(
    vscode.commands.registerCommand(DATABASE_MIGRATE, async function migrate() {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const uris = (
        await findFiles(folder.uri, ([f]) => /\/\d+[^/]+\.sql$/.test(f.path))
      ).sort((a, b) => a.path.localeCompare(b.path));
      if (!uris.length) {
        return vscode.window.showInformationMessage(
          "No migration files detected",
        );
      }
      const files = await Promise.all(
        uris.map(async f => {
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
    }),
  );

  subscriptions.push(
    vscode.commands.registerCommand(
      PGLITE_EXECUTE,
      async function exec(sql: string) {
        try {
          const result = await db.exec(sql, queryOpts);
          result.forEach(stmt => {
            pgliteOutputChannel.appendLine(stmt.statement);
          });
          if (
            result.some(r =>
              ["CREATE", "ALTER", "DROP"].some(stmt =>
                r.statement.startsWith(stmt),
              ),
            )
          ) {
            vscode.commands.executeCommand(PGLITE_INTROSPECT);
            vscode.commands.executeCommand(ERD_UPDATE);
          }
          return result;
        } catch (error) {
          pgliteOutputChannel.appendLine(
            `error: ${error.message ?? JSON.stringify(error)}`,
          );
          return [{ error }];
        }
      },
    ),
  );

  subscriptions.push(
    vscode.commands.registerCommand(PGLITE_RESET, async function reset() {
      pgliteOutputChannel.replace("restarting postgres\n");
      await db.reset();
      vscode.commands.executeCommand(PGLITE_INTROSPECT);
      const {
        rows: [{ version }],
      } = await db.query<{ version: string }>("select version()");
      pgliteOutputChannel.appendLine(version);
    }),
  );

  function createErdPanel() {
    return vscode.window.createWebviewPanel(
      "erd",
      "Entity Relationship Diagram",
      vscode.ViewColumn.Two,
      {
        enableCommandUris: true,
        enableScripts: true,
        retainContextWhenHidden: false,
      },
    );
  }
  let erdPanel: vscode.WebviewPanel | undefined;

  const [updateErd] = throttle(async () => {
    if (erdPanel) {
      const erd = await getMermaidERD();
      const { svg } = await mermaidRender(erd);
      erdPanel.webview.html = svg;
    }
  }, 200);

  subscriptions.push(vscode.commands.registerCommand(ERD_UPDATE, updateErd));
  subscriptions.push(
    vscode.commands.registerCommand(ERD_SHOW, () => {
      if (!erdPanel) erdPanel = createErdPanel();
      updateErd();
      erdPanel.reveal();
    }),
  );

  function createLatestPostsPanel() {
    return vscode.window.createWebviewPanel(
      "latest-posts",
      "Latest Posts",
      vscode.ViewColumn.Two,
      {
        retainContextWhenHidden: true,
        enableScripts: true,
        enableCommandUris: true,
      },
    );
  }
  let latestPanel: vscode.WebviewPanel | undefined;

  async function* renderLatestPosts() {
    const { data, error } = await api.playgrounds.get();
    if (!data || error) {
      if (error) console.log(error);
      yield "failed to fetch latest posts";
      return;
    }
    if (data.length === 0) {
      yield "no posts [yet]";
      return;
    }
    const posts = data.map(p => {
      return `<tr>
        <td><a href="/p/${p.id}">${p.name}</a></td>
        <td><a href="/u/${p.user.username}">${p.user.username}</a></td>
        <td>${p.description}</td>
        <td>${p.stars} stars</td>
      </tr>`;
    });
    yield `<table>${posts.join("")}</table>`;
  }

  subscriptions.push(
    vscode.commands.registerCommand(LATEST_POSTS, async () => {
      if (latestPanel) latestPanel.dispose();
      latestPanel = createLatestPostsPanel();
      latestPanel.reveal();
      for await (const html of renderLatestPosts()) {
        latestPanel.webview.html = html;
      }
    }),
  );

  // vscode.languages.registerDocumentFormattingEditProvider("sql", {
  //   provideDocumentFormattingEdits(
  //     document: vscode.TextDocument,
  //   ): vscode.TextEdit[] {
  //     const firstLine = document.lineAt(0);
  //     if (firstLine.text !== "42") {
  //       return [vscode.TextEdit.insert(firstLine.range.start, "42\n")];
  //     }
  //   },
  // });

  // vscode.languages.registerCodeActionsProvider(
  //   { language: "sql" },
  //   new ExtractNotebookImports(),
  //   {
  //     providedCodeActionKinds: [ExtractNotebookImports.providedKind],
  //   }
  // )
  // );

  // vscode.window.registerWebviewViewProvider(
  //   PlaygroundSidebarView.id,
  //   new PlaygroundSidebarView(),
  // );

  subscriptions.push(
    vscode.commands.registerCommand("github-login", async () => {
      window.location.href = "/auth/github";
    }),
  );

  const dbExplorer = new DatabaseExplorerProvider();
  const dbTreeView = vscode.window.createTreeView(DATABASE_EXPLORER, {
    treeDataProvider: dbExplorer,
  });
  subscriptions.push(dbTreeView);
  const [refreshIntrospection] = throttle(dbExplorer.refresh, 50);
  subscriptions.push(
    vscode.commands.registerCommand(PGLITE_INTROSPECT, () => {
      refreshIntrospection();
      dbTreeView.reveal(undefined, { expand: true });
    }),
  );
});

// const { data: me } = await api.me.get();
// class PlaygroundSidebarView implements vscode.WebviewViewProvider {
//   public static readonly id = PLAYGROUND_INFO;

//   async #getHtmlForWebview(webview: vscode.Webview) {
//     const userInfo = me
//       ? `<p>hello ${me.username}</p>
//         <form method="post" action="/api/logout">
//           <button>logout</a>
//         </form>`
//       : '<button href="/auth/github">login</button>';
//     return `
//       <style type="text/css">${vscodeCss}</style>
//       <h1>playground</h1>
//       ${userInfo}
//     `;
//   }

//   resolveWebviewView(
//     webviewView: vscode.WebviewView,
//     context: vscode.WebviewViewResolveContext,
//     token: vscode.CancellationToken,
//   ): void {
//     this.#getHtmlForWebview(webviewView.webview).then(html => {
//       webviewView.webview.html = html;
//       webviewView.show(true);
//     });
//   }
// }
async function findFiles(
  dir: vscode.Uri,
  predicate?: (x: [f: vscode.Uri, type: vscode.FileType]) => boolean
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

// FIXME: put this somewhere else
const vscodeCss = `
:root {
  --container-paddding: 20px;
  --input-padding-vertical: 6px;
  --input-padding-horizontal: 4px;
  --input-margin-vertical: 4px;
  --input-margin-horizontal: 0;
}

body {
  padding: 0 var(--container-paddding);
  color: var(--vscode-foreground);
  font-size: var(--vscode-font-size);
  font-weight: var(--vscode-font-weight);
  font-family: var(--vscode-font-family);
  background-color: var(--vscode-editor-background);
}

ol,
ul {
  padding-left: var(--container-paddding);
}

body > *,
form > * {
  margin-block-start: var(--input-margin-vertical);
  margin-block-end: var(--input-margin-vertical);
}

*:focus {
  outline-color: var(--vscode-focusBorder) !important;
}

a {
  color: var(--vscode-textLink-foreground);
}

a:hover,
a:active {
  color: var(--vscode-textLink-activeForeground);
}

code {
  font-size: var(--vscode-editor-font-size);
  font-family: var(--vscode-editor-font-family);
}

button {
  border: none;
  padding: var(--input-padding-vertical) var(--input-padding-horizontal);
  width: 100%;
  text-align: center;
  outline: 1px solid transparent;
  outline-offset: 2px !important;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}

button:hover {
  cursor: pointer;
  background: var(--vscode-button-hoverBackground);
}

button:focus {
  outline-color: var(--vscode-focusBorder);
}

button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}

button.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

input:not([type='checkbox']),
textarea {
  display: block;
  width: 100%;
  border: none;
  font-family: var(--vscode-font-family);
  padding: var(--input-padding-vertical) var(--input-padding-horizontal);
  color: var(--vscode-input-foreground);
  outline-color: var(--vscode-input-border);
  background-color: var(--vscode-input-background);
}

input::placeholder,
textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
`;
