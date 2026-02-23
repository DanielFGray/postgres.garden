import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
import { Effect, Scope } from "effect";
import type * as vscode from "vscode";
import {
  DATABASE_EXPLORER,
  DATABASE_MIGRATE,
  ERD_SHOW,
  LATEST_POSTS,
  PGLITE_EXECUTE,
  PGLITE_INTROSPECT,
  PGLITE_RESET,
  PLAYGROUND_CREATE,
  PLAYGROUND_METADATA,
  PLAYGROUND_OPEN,
  PLAYGROUND_OPEN_CURRENT,
  PLAYGROUND_REFRESH_METADATA,
  PLAYGROUND_SHOW_BROWSER,
  PLAYGROUND_TOGGLE_STAR,
  SERVER_SYNC_CHECKOUT_VERSION,
  SERVER_SYNC_COMMIT,
  SERVER_SYNC_COMMIT_HISTORY,
  SERVER_SYNC_FORK_HISTORY,
  SERVER_SYNC_LOAD_COMMIT,
  SERVER_SYNC_REFRESH,
  SERVER_SYNC_REFRESH_FORK_HISTORY,
  SERVER_SYNC_REFRESH_HISTORY,
  SERVER_SYNC_RESTORE_COMMIT,
  SERVER_SYNC_VIEW_COMMIT,
  SERVER_SYNC_VIEW_FORK_SOURCE,
  WORKSPACE_DOWNLOAD,
} from "../features/constants";
import { Workbench } from "../workbench";

type VSCodeApi = typeof vscode;

const manifest: Parameters<typeof registerExtension>[0] = {
  name: "postgres.garden",
  publisher: "postgres.garden",
  description: "postgres.garden",
  version: "1.0.0",
  engines: { vscode: "*" },
  capabilities: { virtualWorkspaces: true },
  extensionKind: ["workspace"],
  enabledApiProposals: ["scmActionButton"],
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
      { language: "sql", scopeName: "source.sql", path: "./syntaxes/sql.tmLanguage.json" },
    ],
    commands: [
      { command: PGLITE_RESET, title: "Reset database", icon: "$(trash)" },
      { command: PGLITE_EXECUTE, title: "Execute SQL", icon: "$(notebook-execute)" },
      { command: SERVER_SYNC_COMMIT, title: "Save", icon: "$(cloud-upload)" },
      { command: PGLITE_INTROSPECT, title: "Refresh introspection data", icon: "$(repo-sync)" },
      { command: DATABASE_MIGRATE, title: "Run migrations", icon: "$(run-all)" },
      { command: LATEST_POSTS, title: "Latest Posts", icon: "$(clock)" },
      { command: ERD_SHOW, title: "Show ERD", icon: "$(type-hierarchy)" },
      { command: WORKSPACE_DOWNLOAD, title: "Download workspace", icon: "$(desktop-download)" },
      { command: PLAYGROUND_SHOW_BROWSER, title: "Show Playgrounds", icon: "$(database)" },
      { command: PLAYGROUND_OPEN, title: "Open Playground Metadata" },
      {
        command: PLAYGROUND_OPEN_CURRENT,
        title: "Edit Current Playground Metadata",
        icon: "$(edit)",
      },
      { command: PLAYGROUND_CREATE, title: "Create Playground", icon: "$(add)" },
      {
        command: PLAYGROUND_REFRESH_METADATA,
        title: "Refresh Playground Metadata",
        icon: "$(refresh)",
      },
      { command: PLAYGROUND_TOGGLE_STAR, title: "Toggle Star", icon: "$(star-empty)" },
      {
        command: SERVER_SYNC_REFRESH,
        title: "Server Sync: Reload from Server",
        icon: "$(refresh)",
      },
      {
        command: SERVER_SYNC_REFRESH_HISTORY,
        title: "Server Sync: Refresh History",
        icon: "$(refresh)",
      },
      { command: SERVER_SYNC_VIEW_COMMIT, title: "View Commit Diff" },
      { command: SERVER_SYNC_LOAD_COMMIT, title: "Load Commit", icon: "$(folder-opened)" },
      { command: SERVER_SYNC_RESTORE_COMMIT, title: "Restore from Commit", icon: "$(history)" },
      { command: SERVER_SYNC_CHECKOUT_VERSION, title: "Checkout Version", icon: "$(git-branch)" },
      { command: SERVER_SYNC_VIEW_FORK_SOURCE, title: "View Fork Source", icon: "$(repo-forked)" },
      {
        command: SERVER_SYNC_REFRESH_FORK_HISTORY,
        title: "Server Sync: Refresh Fork History",
        icon: "$(refresh)",
      },
    ],
    menus: {
      commandPalette: [{ command: PGLITE_EXECUTE, when: "editorLangId == sql" }],
      "view/title": [
        { command: ERD_SHOW, when: "view == databaseExplorer", group: "navigation" },
        { command: PGLITE_INTROSPECT, when: "view == databaseExplorer", group: "navigation" },
        {
          command: SERVER_SYNC_COMMIT,
          when: `view == ${PLAYGROUND_METADATA}`,
          group: "navigation",
        },
        {
          command: PLAYGROUND_REFRESH_METADATA,
          when: `view == ${PLAYGROUND_METADATA}`,
          group: "navigation",
        },
        {
          command: SERVER_SYNC_REFRESH_HISTORY,
          when: `view == ${SERVER_SYNC_COMMIT_HISTORY}`,
          group: "navigation",
        },
        {
          command: SERVER_SYNC_REFRESH_FORK_HISTORY,
          when: `view == ${SERVER_SYNC_FORK_HISTORY}`,
          group: "navigation",
        },
      ],
      "view/item/context": [
        {
          command: SERVER_SYNC_LOAD_COMMIT,
          when: `view == ${SERVER_SYNC_COMMIT_HISTORY} && viewItem == commit`,
          group: "inline",
        },
        {
          command: SERVER_SYNC_VIEW_FORK_SOURCE,
          when: `view == ${SERVER_SYNC_FORK_HISTORY} && viewItem == fork`,
          group: "inline",
        },
      ],
      "editor/title": [
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
        { id: PLAYGROUND_METADATA, name: "Playground Info", type: "webview", when: "true" },
      ],
      scm: [
        { id: SERVER_SYNC_COMMIT_HISTORY, name: "Commit History" },
        { id: SERVER_SYNC_FORK_HISTORY, name: "Fork History" },
      ],
    },
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
    configuration: [
      {
        order: 22,
        title: "postgres.garden",
        properties: {
          "postgres.garden.introspection-tree.grouping": {
            title: "introspection tree grouping",
            type: "string",
            enum: ["alphabetical", "grouped by type"],
            default: "grouped by type",
            description: "Grouping of the introspection tree.",
          },
        },
      },
    ],
  },
};

type VSCodeServiceApi = {
  readonly api: VSCodeApi;
  readonly extensionUri: vscode.Uri;
  readonly registerCommand: (
    command: string,
    callback: (...args: readonly unknown[]) => unknown,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly registerFileUrl: (path: string, url: string) => Effect.Effect<void, never, never>;
};

export class VSCodeService extends Effect.Service<VSCodeService>()("app/VSCodeService", {
  dependencies: [Workbench.Default],
  effect: Effect.gen(function*() {
    const extension = registerExtension(manifest, ExtensionHostKind.LocalProcess, {
      system: true,
    });

    const api = yield* Effect.tryPromise({
      try: () => extension.getApi(),
      catch: (error) =>
        Effect.dieMessage(
          `Failed to get VSCode API: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const extensionUri = api.Uri.parse(window.location.origin);

    const registerCommand: VSCodeServiceApi["registerCommand"] = (command, callback) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          api.commands.registerCommand(command, (...args: unknown[]) => callback(...args)),
        ),
        (disposable) => Effect.sync(() => disposable.dispose()),
      ).pipe(Effect.asVoid);

    const registerFileUrl: VSCodeServiceApi["registerFileUrl"] = (path, url) =>
      Effect.sync(() => {
        extension.registerFileUrl(path, url);
      });

    return {
      api,
      extensionUri,
      registerCommand,
      registerFileUrl,
    };
  }),
}) { }
