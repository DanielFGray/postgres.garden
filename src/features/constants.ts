import type { Results } from "@electric-sql/pglite";

// Command IDs
export const PGLITE_RESET = "pg-playground.reset";
export const PGLITE_EXECUTE = "pg-playground.execute";
export const PGLITE_INTROSPECT = "pg-playground.introspect";
export const DATABASE_MIGRATE = "pg-playground.migrate";
export const LATEST_POSTS = "pg-playground.latestPosts";

// Auth Commands
export const GITHUB_SIGNIN = "github.signin";
export const GITHUB_SIGNOUT = "github.signout";
export const GITHUB_ACCOUNT_MENU = "github.accountmenu";

// Server Sync Commands
export const SERVER_SYNC_COMMIT = "server-sync.commit";
export const SERVER_SYNC_REFRESH = "server-sync.refresh";
export const SERVER_SYNC_REFRESH_HISTORY = "server-sync.refreshHistory";
export const SERVER_SYNC_VIEW_COMMIT = "server-sync.viewCommit";
export const SERVER_SYNC_LOAD_COMMIT = "server-sync.loadCommit";
export const SERVER_SYNC_RESTORE_COMMIT = "server-sync.restoreCommit";
export const SERVER_SYNC_WORKSPACE_LOADED = "server-sync.workspaceLoaded";
export const SERVER_SYNC_CHECKOUT_VERSION = "server-sync.checkoutVersion";
export const SERVER_SYNC_VIEW_FORK_SOURCE = "server-sync.viewForkSource";
export const SERVER_SYNC_REFRESH_FORK_HISTORY = "server-sync.refreshForkHistory";

// ERD Commands
export const ERD_SHOW = "pg-playground.erdShow";

// Workspace Commands
export const WORKSPACE_DOWNLOAD = "pg-playground.downloadWorkspace";

// Playground Commands
export const PLAYGROUND_SHOW_BROWSER = "playground.showBrowser";
export const PLAYGROUND_OPEN = "playground.open";
export const PLAYGROUND_OPEN_CURRENT = "playground.openCurrent";
export const PLAYGROUND_REFRESH_METADATA = "playground.refreshMetadata";
export const PLAYGROUND_CREATE = "playground.create";

// VSCode Built-in Commands (used in our code)
export const VSCODE_OPEN = "vscode.open";
export const VSCODE_DIFF = "vscode.diff";
export const WORKBENCH_ACTION_CLOSE_ALL_EDITORS =
  "workbench.action.closeAllEditors";


// Account Commands
export const ACCOUNT_SETTINGS_OPEN = "account.openSettings";

// View IDs
export const DATABASE_EXPLORER = "databaseExplorer";
export const PLAYGROUND_METADATA = "playground.metadata";
export const SERVER_SYNC_COMMIT_HISTORY = "serverSync.commitHistory";
export const SERVER_SYNC_FORK_HISTORY = "serverSync.forkHistory";

// Extended Results type that includes statement info and error handling
export type ExtendedResults =
  | (Results & { statement?: string })
  | { error: Error; statement?: string };
