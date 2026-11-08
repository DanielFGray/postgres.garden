/**
 * Server Sync Feature
 * Provides workspace persistence by syncing files to the server via SCM interface
 */

import * as vscode from "vscode";
import type { SourceControlResourceState, TreeDataProvider, TreeItem } from "vscode";
import { DateTime, Effect, Layer, Match, Option, pipe, Schema } from "effect";
import { navigateTo } from "../shared/navigation";
import { ApiCaller } from "../httpapi-client";
import {
  editKeyLink,
  forgetEditKey,
  heldEditKey,
  rememberEditKey,
  takeEditKeyFromUrl,
} from "../shared/editKey";
import { buildPath, getCurrentPlaygroundId } from "../shared/routes";
import { VSCodeService } from "../vscode/service";
import { Workbench } from "../workbench";
import {
  SERVER_SYNC_COMMIT,
  SERVER_SYNC_REFRESH,
  SERVER_SYNC_REFRESH_HISTORY,
  SERVER_SYNC_VIEW_COMMIT,
  SERVER_SYNC_LOAD_COMMIT,
  SERVER_SYNC_RESTORE_COMMIT,
  SERVER_SYNC_WORKSPACE_LOADED,
  SERVER_SYNC_COMMIT_HISTORY,
  SERVER_SYNC_FORK_HISTORY,
  SERVER_SYNC_CHECKOUT_VERSION,
  SERVER_SYNC_VIEW_FORK_SOURCE,
  SERVER_SYNC_REFRESH_FORK_HISTORY,
  VSCODE_OPEN,
  VSCODE_DIFF,
} from "./constants";
import { LoadedWorkspace } from "./loadedWorkspace";

// Commit history types
interface CommitHistoryItem {
  id: string;
  message: string;
  timestamp: string;
  fileCount?: number;
  username?: string;
}

// Fork history types
interface ForkHistoryItem {
  hash: string;
  name: string;
  owner?: string;
  isCurrent: boolean;
}

class ServerSyncError extends Schema.TaggedError<
  ServerSyncError,
  { readonly brand: unique symbol }
>()("ServerSyncError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Where the key that holds an unclaimed playground lives, and how it travels.
 *
 * It travels in the URL fragment, which the browser never sends to the server,
 * so it reaches no request log and no trace. The page then takes it out of the
 * address bar: a URL copied from the bar to show someone a playground must not
 * also hand them the right to edit it.
 *
 * It is kept in session storage under its playground's hash, so a reload of
 * this tab can still save, and so a key for one playground can never go out
 * with a save to another.
 */
const decodeStringArgument = Schema.decodeUnknownOption(Schema.String);
const CommandItem = Schema.Struct({ id: Schema.String });
const decodeCommandItem = Schema.decodeUnknownOption(CommandItem);
const WorkspaceLoaded = Schema.Struct({
  commitId: Schema.String,
  playgroundHash: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const decodeWorkspaceLoaded = Schema.decodeUnknownOption(WorkspaceLoaded);
const toServerSyncError = (cause: unknown) =>
  new ServerSyncError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
export const ServerSyncFeatureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    const { runFork } = yield* Workbench;
    const loadedWorkspace = yield* LoadedWorkspace;
    const runtime = yield* Effect.context<never>();
    const { call } = yield* ApiCaller;
    const vscodeApi = vscodeService.api;

    yield* Effect.log("[ServerSync] API received, checking workspace...");
    const workspaceFolder = vscodeApi.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      yield* Effect.logWarning("[ServerSync] No workspace folder found, skipping initialization");
      return;
    }

    yield* Effect.log("[ServerSync] Initializing workspace sync...");

    const changedFiles = new Map<string, vscode.Uri>(); // Track changed files
    let currentCommitId: string | null = null; // Track the currently loaded commit
    let currentPlaygroundHash: string | null = null; // Track the currently loaded playground hash
    takeEditKeyFromUrl();
    const baselineFiles = new Map<string, string>(); // Track file contents at last commit for diff comparison

    // Custom URI scheme for baseline content
    const BASELINE_SCHEME = "server-sync-baseline";

    /**
     * Provides baseline file content for quick diff
     */
    class BaselineContentProvider implements vscode.TextDocumentContentProvider {
      private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

      get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
      }

      provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
        // Extract the file path from the URI
        const filePath = uri.path;

        // Return the baseline content
        const content = baselineFiles.get(filePath);
        return content || "";
      }

      /**
       * Fire change event to refresh quick diff decorations
       */
      fireChange(uri: vscode.Uri) {
        this._onDidChange.fire(uri);
      }
    }

    /**
     * Quick diff provider for showing inline diff decorations
     */
    class ServerSyncQuickDiffProvider implements vscode.QuickDiffProvider {
      provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
        // Convert workspace file URI to baseline URI
        return vscode.Uri.parse(`${BASELINE_SCHEME}:${uri.path}`);
      }
    }

    const baselineContentProvider = new BaselineContentProvider();
    const quickDiffProvider = new ServerSyncQuickDiffProvider();

    /**
     * Refresh quick diff decorations for all workspace files
     */
    const refreshQuickDiff = Effect.fnUntraced(function* () {
      const allFiles = yield* Effect.tryPromise({
        try: () => vscodeApi.workspace.findFiles("**/*", "**/node_modules/**"),
        catch: toServerSyncError,
      });

      yield* Effect.forEach(allFiles, (fileUri) =>
        Effect.sync(() => {
          baselineContentProvider.fireChange(
            vscode.Uri.parse(`${BASELINE_SCHEME}:${fileUri.path}`),
          );
        }),
      );
    });

    /**
     * Scan workspace and collect all files
     */
    const scanWorkspace = Effect.fnUntraced(function* () {
      const allFiles = yield* Effect.tryPromise({
        try: () => vscodeApi.workspace.findFiles("**/*"),
        catch: toServerSyncError,
      });
      const files: Array<{ path: string; content: string }> = [];

      yield* Effect.forEach(allFiles, (fileUri) =>
        Effect.tryPromise({
          try: () => vscodeApi.workspace.fs.readFile(fileUri),
          catch: toServerSyncError,
        }).pipe(
          Effect.tap((content) =>
            Effect.sync(() => {
              files.push({
                path: fileUri.path,
                content: new TextDecoder().decode(content),
              });
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning(`[ServerSync] Failed to read file ${fileUri.path}:`, error),
          ),
        ),
      );

      yield* Effect.log(`[ServerSync] Scanned workspace: ${files.length} files`);
      return files;
    });

    /**
     * Turn the key this tab holds into ownership of the playground.
     *
     * A key the server will not take is not a failure to report: the save that
     * follows then forks the playground, which is what saving a playground that
     * is not the caller's has always done. The answer says which happened, so a
     * caller does not tell the author their work was kept when it was not. A
     * key that is taken is spent, so it leaves this tab's storage.
     */
    const claimWithEditKey = Effect.fnUntraced(function* (hash: string) {
      return yield* call("apiPlaygrounds.claimPlayground", (api) =>
        api.apiPlaygrounds.claimPlayground({ params: { hash } }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => forgetEditKey(hash))),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("[ServerSync] The edit key did not claim the playground:", error).pipe(
            Effect.as(false),
          ),
        ),
      );
    });

    /**
     * Commit workspace to server
     */
    const commitWorkspace = Effect.fnUntraced(function* (message?: string) {
      yield* Effect.tryPromise({
        try: () =>
          // Show progress
          vscodeApi.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Syncing workspace to server...",
              cancellable: false,
            },
            (progress) =>
              Effect.runPromiseWith(runtime)(
                Effect.gen(function* () {
                  progress.report({ message: "Saving files..." });

                  // Flush all unsaved editor buffers to the virtual filesystem
                  // so scanWorkspace() picks up the latest content
                  yield* Effect.tryPromise({
                    try: () => vscodeApi.workspace.saveAll(false),
                    catch: toServerSyncError,
                  });

                  progress.report({ message: "Scanning files..." });

                  // Scan all files
                  const files = yield* scanWorkspace();

                  if (files.length === 0) {
                    vscodeApi.window.showWarningMessage("No files to sync");
                    return;
                  }

                  progress.report({ message: `Uploading ${files.length} files...` });

                  // Get the currently active editor file path
                  const activeEditor = vscodeApi.window.activeTextEditor;
                  const activeFile = activeEditor?.document.uri.path ?? null;

                  // Prepare commit message
                  // Note: when invoked from editor/title menu, VS Code passes the
                  // active editor URI as the first arg — ignore non-string values
                  const commitMessage =
                    message ||
                    scm.inputBox.value ||
                    `Workspace snapshot at ${DateTime.formatIso(DateTime.nowUnsafe())}`;

                  // Generate unique name (slug) for the playground
                  // Format: workspace_YYYYMMDD_HHMMSS_milliseconds
                  const now = DateTime.nowUnsafe();
                  const nowDate = DateTime.toDate(now);
                  const playgroundName = `workspace_${nowDate.getFullYear()}${String(nowDate.getMonth() + 1).padStart(2, "0")}${String(nowDate.getDate()).padStart(2, "0")}_${String(nowDate.getHours()).padStart(2, "0")}${String(nowDate.getMinutes()).padStart(2, "0")}${String(nowDate.getSeconds()).padStart(2, "0")}_${nowDate.getMilliseconds()}`;

                  // Send to server using Eden Treaty for type safety
                  yield* Effect.log("[ServerSync] Sending commit request:", {
                    playground_hash: currentPlaygroundHash,
                    fileCount: files.length,
                    message: commitMessage,
                  });

                  // Check if user is authenticated by querying the server
                  // We check with the server instead of just the local auth provider
                  // because the session cookie is the source of truth for authentication
                  const me = yield* call("apiUsers.me", (api) => api.apiUsers.me({})).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("[ServerSync] Failed to check auth status:", error).pipe(
                        Effect.map(() => null),
                      ),
                    ),
                  );
                  const isAuthenticated = !!me?.user?.id;
                  yield* Effect.log("[ServerSync] Auth check:", {
                    isAuthenticated,
                    userId: me?.user?.id,
                    username: me?.user?.username,
                  });

                  // A save goes to the server either way. An account is one way
                  // to prove the playground on screen is the caller's to write
                  // to; the key this tab holds for it is the other.
                  //
                  // Signing in while holding a key is how an unclaimed
                  // playground gets an owner, so the claim goes first: from
                  // then on the account is what the server matches against.
                  // Which playground is on screen: the URL says so from the
                  // first paint, while currentPlaygroundHash waits for the
                  // workspace-loaded notification. A tab opened straight on a
                  // playground can be saved before that arrives, and it must
                  // save to the playground it is showing.
                  const openPlayground = currentPlaygroundHash ?? getCurrentPlaygroundId();

                  const heldKey = heldEditKey(openPlayground);
                  const claimedNow =
                    isAuthenticated && heldKey !== null && openPlayground !== null
                      ? yield* claimWithEditKey(openPlayground)
                      : false;
                  const editKey = claimedNow ? null : heldKey;

                  // With neither, the save starts a playground of its own.
                  // Reading someone else's playground and saving is how a
                  // visitor with no account keeps their work, and the server
                  // would refuse a commit to a playground they cannot prove is
                  // theirs.
                  const saveTo =
                    openPlayground !== null && (isAuthenticated || editKey !== null)
                      ? openPlayground
                      : null;

                  // The two endpoints answer the same five fields and one of
                  // their own, so each fills in the other's: one shape means
                  // the code below reads a field instead of asking which
                  // endpoint it came from.
                  const saved = saveTo
                    ? call("apiPlaygrounds.createCommit", (api) =>
                        api.apiPlaygrounds.createCommit({
                          params: { hash: saveTo },
                          payload: {
                            message: commitMessage,
                            files,
                            activeFile,
                          },
                        }),
                      ).pipe(
                        Effect.map((result) => ({
                          ...result,
                          edit_key: null,
                          expires_at: null,
                        })),
                      )
                    : call("apiPlaygrounds.createPlayground", (api) =>
                        api.apiPlaygrounds.createPlayground({
                          payload: {
                            name: playgroundName,
                            message: commitMessage,
                            description: "New playground",
                            files,
                            activeFile,
                          },
                        }),
                      ).pipe(Effect.map((result) => ({ ...result, forked: false })));

                  const result = yield* saved.pipe(
                    Effect.asSome,
                    Effect.catch((error) =>
                      Effect.gen(function* () {
                        yield* Effect.logError("[ServerSync] Commit failed:", error);
                        if (error.status === 401) {
                          const choice = yield* Effect.tryPromise({
                            try: () =>
                              vscodeApi.window.showWarningMessage(
                                "Your session has expired. Please sign in again to sync.",
                                "Sign In",
                                "Cancel",
                              ),
                            catch: toServerSyncError,
                          });
                          if (choice === "Sign In") {
                            yield* Effect.tryPromise({
                              try: () =>
                                vscodeApi.authentication.getSession("github-auth", [], {
                                  createIfNone: true,
                                  forceNewSession: true,
                                }),
                              catch: toServerSyncError,
                            }).pipe(
                              Effect.tap(() =>
                                Effect.sync(() =>
                                  vscodeApi.window.showInformationMessage(
                                    "Signed in successfully. Please try syncing again.",
                                  ),
                                ),
                              ),
                              Effect.catch(() =>
                                Effect.sync(() =>
                                  vscodeApi.window.showErrorMessage(
                                    "Authentication failed. Please try again.",
                                  ),
                                ),
                              ),
                            );
                          }
                          return Option.none();
                        }
                        return yield* new ServerSyncError({
                          message: `Failed to commit workspace: ${error.status} ${error.message}`,
                          cause: error,
                        });
                      }),
                    ),
                  );
                  if (Option.isNone(result)) return;
                  const commitResult = result.value;

                  // API returns { commit_id, playground_hash, parent_id, message, created_at }
                  if (!commitResult.commit_id) {
                    return yield* new ServerSyncError({
                      message: "Failed to commit workspace",
                      cause: "Failed to commit workspace",
                    });
                  }

                  // The key is answered once and the author keeps it. It must
                  // not be the console that keeps a copy as well.
                  yield* Effect.log("[ServerSync] Commit successful:", {
                    ...commitResult,
                    edit_key: commitResult.edit_key === null ? null : "[redacted]",
                  });
                  yield* Effect.log(
                    "[ServerSync] Files committed:",
                    files.map((f) => ({ path: f.path, size: f.content.length })),
                  );

                  // Check if playground hash changed (new playground created)
                  const playgroundHashChanged =
                    currentPlaygroundHash !== commitResult.playground_hash;
                  const wasForked = commitResult.forked;

                  // A commit that moves the workspace to another playground (new or
                  // forked) changes which playground is loaded, though no file changes.
                  if (playgroundHashChanged) yield* loadedWorkspace.replace(Effect.void);

                  // Update current commit and playground tracking
                  currentCommitId = commitResult.commit_id;
                  if (commitResult.playground_hash) {
                    currentPlaygroundHash = commitResult.playground_hash;
                  }

                  // A playground started without an account comes back with the
                  // key that holds it. The server answers it once and keeps only
                  // its digest, so this is the only moment it can be kept.
                  if (commitResult.edit_key !== null) {
                    rememberEditKey(commitResult.playground_hash, commitResult.edit_key);
                  }

                  // Navigate to the playground URL if hash changed
                  // This happens for:
                  // - First sync (no previous hash)
                  // - Anonymous user syncing (always creates new playground)
                  // - Authenticated user forking (anonymous or other user's playground)
                  if (playgroundHashChanged && commitResult.playground_hash) {
                    yield* Effect.log(
                      "[ServerSync] Playground hash changed - updating URL to:",
                      commitResult.playground_hash,
                      wasForked
                        ? "(forked)"
                        : isAuthenticated
                          ? "(first sync)"
                          : "(anonymous snapshot)",
                    );

                    // Update URL to reflect the new playground. The key stays
                    // out of the address bar: session storage is holding it.
                    const path = buildPath({
                      type: "playground",
                      playgroundHash: commitResult.playground_hash,
                    });
                    window.history.replaceState(null, "", path);
                  }

                  // Clear input box
                  scm.inputBox.value = "";

                  // Update baseline (like Git after commit - now everything is "clean")
                  baselineFiles.clear();
                  files.forEach((f) => baselineFiles.set(f.path, f.content));

                  // Clear changed files list (like Git - nothing is changed after commit)
                  changedFiles.clear();
                  updateSCMView();

                  // Refresh quick diff decorations to reflect new baseline
                  yield* refreshQuickDiff();

                  // Show success message with appropriate context
                  if (wasForked) {
                    // Authenticated user forked the playground
                    vscodeApi.window.showInformationMessage(
                      `Playground forked: ${files.length} file(s) saved. You now own this copy and can continue making commits.`,
                    );
                  } else if (commitResult.edit_key !== null) {
                    // A playground saved without an account is held by its key
                    // and by nothing else: there is no password to recover and
                    // no account to sign in to, so the link is the whole claim
                    // to it. Hence the clipboard and the warning.
                    const editLink = editKeyLink(
                      `${window.location.origin}${buildPath({
                        type: "playground",
                        playgroundHash: commitResult.playground_hash,
                      })}`,
                      commitResult.edit_key,
                    );
                    const copied = yield* Effect.tryPromise({
                      try: () => navigator.clipboard.writeText(editLink),
                      catch: toServerSyncError,
                    }).pipe(
                      Effect.as(true),
                      Effect.catch((error) =>
                        Effect.logWarning("[ServerSync] Could not copy the edit link:", error).pipe(
                          Effect.as(false),
                        ),
                      ),
                    );

                    // The clipboard refuses a write often enough - a browser
                    // counts the time since the click - that a message saying
                    // the link is on it would, on that day, lose the
                    // playground. So the message carries the link itself when
                    // the copy did not happen.
                    const where = copied
                      ? "Your edit link is on the clipboard"
                      : `Your edit link is ${editLink}`;
                    const until =
                      commitResult.expires_at === null
                        ? ""
                        : ` It is removed on ${DateTime.formatIsoDate(commitResult.expires_at)} unless an account claims it.`;
                    const action = yield* Effect.tryPromise({
                      try: () =>
                        vscodeApi.window.showWarningMessage(
                          `Saved ${files.length} file(s). ${where} - keep it, because it is the only way back into this playground, and anyone who has it can edit it.${until} Sign in to keep the playground on your account instead.`,
                          "Sign In to Keep It",
                        ),
                      catch: toServerSyncError,
                    });

                    if (action === "Sign In to Keep It") {
                      yield* Effect.gen(function* () {
                        yield* Effect.tryPromise({
                          try: () =>
                            vscodeApi.authentication.getSession("github-auth", [], {
                              createIfNone: true,
                            }),
                          catch: toServerSyncError,
                        });

                        // The key is what proves this playground is theirs to
                        // keep, so the claim goes in while the tab still holds
                        // it rather than waiting for the next save.
                        const hash = commitResult.playground_hash;
                        const key = heldEditKey(hash);
                        if (key === null) return;
                        if (yield* claimWithEditKey(hash)) {
                          vscodeApi.window.showInformationMessage(
                            "This playground is on your account now, and the edit link no longer opens it.",
                          );
                        }
                      }).pipe(Effect.ignore);
                    }
                  } else {
                    // Authenticated user committing to their own playground
                    vscodeApi.window.showInformationMessage(
                      `Workspace synced: ${files.length} file(s) saved`,
                    );
                  }

                  // Refresh commit history and status bar
                  commitHistoryProvider.refresh();
                  forkHistoryProvider.refresh();
                  yield* updateStatusBar();
                }),
              ),
          ),
        catch: toServerSyncError,
      });
    });

    /**
     * Update SCM view with changed files
     */
    function updateSCMView() {
      const resourceStates: SourceControlResourceState[] = Array.from(changedFiles.values()).map(
        (uri) => ({
          resourceUri: uri,
          command: {
            title: "Open",
            command: VSCODE_OPEN,
            arguments: [uri],
          },
        }),
      );

      workingTreeGroup.resourceStates = resourceStates;
      scm.count = resourceStates.length;
    }

    /**
     * Mark file as changed (only if actually different from baseline)
     */
    const markFileAsChanged = Effect.fnUntraced(function* (uri: vscode.Uri) {
      const key = uri.toString();

      yield* Effect.tryPromise({
        try: () => vscodeApi.workspace.fs.readFile(uri),
        catch: toServerSyncError,
      }).pipe(
        Effect.flatMap((content) => {
          const textContent = new TextDecoder().decode(content);

          // Compare with baseline
          const baselineContent = baselineFiles.get(uri.path);

          if (baselineContent === textContent) {
            // File matches baseline - remove from changed list if present
            if (changedFiles.has(key)) {
              changedFiles.delete(key);
              updateSCMView();
              return Effect.log(`[ServerSync] File reverted to baseline: ${uri.path}`);
            }
          } else {
            // File is different from baseline - mark as changed
            if (!changedFiles.has(key)) {
              changedFiles.set(key, uri);
              updateSCMView();
              return Effect.log(`[ServerSync] File changed: ${uri.path}`);
            }
          }
          return Effect.void;
        }),
        Effect.catch(() => {
          // File might be deleted or unreadable
          const baselineContent = baselineFiles.get(uri.path);
          if (baselineContent !== undefined) {
            // File existed in baseline but now deleted/unreadable - mark as changed
            if (!changedFiles.has(key)) {
              changedFiles.set(key, uri);
              updateSCMView();
              return Effect.log(`[ServerSync] File deleted: ${uri.path}`);
            }
          }
          return Effect.void;
        }),
      );
    });

    /**
     * Commit History Tree Data Provider
     */
    class CommitHistoryProvider implements TreeDataProvider<CommitHistoryItem> {
      private _onDidChangeTreeData: vscode.EventEmitter<CommitHistoryItem | undefined | void> =
        new vscode.EventEmitter<CommitHistoryItem | undefined | void>();
      readonly onDidChangeTreeData: vscode.Event<CommitHistoryItem | undefined | void> =
        this._onDidChangeTreeData.event;

      refresh(): void {
        this._onDidChangeTreeData.fire();
      }

      getTreeItem(element: CommitHistoryItem): TreeItem {
        const isCurrentCommit = element.id === currentCommitId;
        const label = element.message || `Commit ${element.id.substring(0, 8)}`;
        const treeItem = new vscode.TreeItem(isCurrentCommit ? `✓ ${label}` : label);
        treeItem.id = element.id;
        treeItem.description = DateTime.formatLocal(DateTime.makeUnsafe(element.timestamp));
        treeItem.tooltip = `${element.fileCount} file(s) • ${element.username || "Unknown user"} • ${element.id}${isCurrentCommit ? " (currently loaded)" : ""}`;
        treeItem.contextValue = "commit";
        treeItem.iconPath = new vscode.ThemeIcon(isCurrentCommit ? "circle-filled" : "git-commit");
        treeItem.command = {
          command: SERVER_SYNC_VIEW_COMMIT,
          title: "View Commit",
          arguments: [element.id],
        };
        return treeItem;
      }

      getChildren(element?: CommitHistoryItem): Promise<CommitHistoryItem[]> {
        return Effect.runPromiseWith(runtime)(
          Effect.gen(function* () {
            if (element || !currentPlaygroundHash) {
              if (!element) {
                yield* Effect.log("[ServerSync] No playground loaded, commit history is empty");
              }
              return [];
            }

            const hash = currentPlaygroundHash;

            const commits = yield* call("apiPlaygrounds.listCommits", (api) =>
              api.apiPlaygrounds.listCommits({ params: { hash } }),
            ).pipe(
              Effect.catch((error) =>
                Effect.logError("[ServerSync] Error loading commits:", error).pipe(
                  Effect.map(() => null),
                ),
              ),
            );
            if (!commits || !Array.isArray(commits)) return [];

            yield* Effect.log(
              `[ServerSync] Showing ${commits.length} commits for playground ${currentPlaygroundHash}`,
            );
            return commits.map((c) => ({
              id: c.id,
              message: c.message,
              timestamp: String(c.timestamp),
              username: c.username,
            }));
          }),
        );
      }
    }

    const commitHistoryProvider = new CommitHistoryProvider();

    // Register tree view for commit history in SCM view container
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.window.createTreeView(SERVER_SYNC_COMMIT_HISTORY, {
          treeDataProvider: commitHistoryProvider,
          showCollapseAll: false,
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    /**
     * Fork History Tree Data Provider
     * Shows the fork chain for the current playground
     */
    class ForkHistoryProvider implements TreeDataProvider<ForkHistoryItem> {
      private _onDidChangeTreeData: vscode.EventEmitter<ForkHistoryItem | undefined | void> =
        new vscode.EventEmitter<ForkHistoryItem | undefined | void>();
      readonly onDidChangeTreeData: vscode.Event<ForkHistoryItem | undefined | void> =
        this._onDidChangeTreeData.event;

      private forkChain: ForkHistoryItem[] = [];

      refresh(): void {
        this._onDidChangeTreeData.fire();
      }

      getTreeItem(element: ForkHistoryItem): TreeItem {
        const label = element.name || element.hash.substring(0, 8);
        const treeItem = new vscode.TreeItem(element.isCurrent ? `✓ ${label}` : label);
        treeItem.id = element.hash;
        treeItem.description = element.owner ? `by ${element.owner}` : "anonymous";
        treeItem.tooltip = `${element.hash}${element.isCurrent ? " (current)" : ""}`;
        treeItem.contextValue = "fork";
        treeItem.iconPath = new vscode.ThemeIcon(
          element.isCurrent ? "circle-filled" : "repo-forked",
        );
        if (!element.isCurrent) {
          treeItem.command = {
            command: SERVER_SYNC_VIEW_FORK_SOURCE,
            title: "Open Fork Source",
            arguments: [element.hash],
          };
        }
        return treeItem;
      }

      getChildren(element?: ForkHistoryItem): Promise<ForkHistoryItem[]> {
        return Effect.runPromiseWith(runtime)(
          Effect.gen({ self: this }, function* () {
            if (element || !currentPlaygroundHash) return [];

            const chain: ForkHistoryItem[] = [];
            let currentHash: string | null = currentPlaygroundHash;

            while (currentHash) {
              const hash = currentHash;
              const playground = yield* call("apiPlaygrounds.playgroundByHash", (api) =>
                api.apiPlaygrounds.playgroundByHash({ params: { hash } }),
              ).pipe(
                Effect.catch((error) =>
                  Effect.logError("[ServerSync] Error loading fork history:", error).pipe(
                    Effect.map(() => null),
                  ),
                ),
              );
              if (!playground) break;

              // Eden narrows the union to `never` after the error guard — widen it
              const pg = playground as {
                hash: string;
                name: string | null;
                user?: { username: string } | null;
                fork_of?: { hash: string } | null;
              };

              chain.push({
                hash: pg.hash,
                name: pg.name ?? "Untitled",
                owner: pipe(
                  Option.fromNullishOr(pg.user),
                  Option.flatMap((user) => Option.fromNullishOr(user.username)),
                  Option.getOrUndefined,
                ),
                isCurrent: pg.hash === currentPlaygroundHash,
              });

              currentHash = pipe(
                Option.fromNullishOr(pg.fork_of),
                Option.flatMap((forkOf) => Option.fromNullishOr(forkOf.hash)),
                Option.getOrNull,
              );
            }

            // Show from oldest to newest (fork source first)
            this.forkChain = chain.reverse();

            yield* Effect.log(`[ServerSync] Fork history: ${this.forkChain.length} items`);

            return this.forkChain;
          }),
        );
      }
    }

    const forkHistoryProvider = new ForkHistoryProvider();

    // Register tree view for fork history in SCM view container
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.window.createTreeView(SERVER_SYNC_FORK_HISTORY, {
          treeDataProvider: forkHistoryProvider,
          showCollapseAll: false,
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    // Register commands
    yield* vscodeService.registerCommand(SERVER_SYNC_COMMIT, (message) => {
      runFork(
        commitWorkspace(Option.getOrUndefined(decodeStringArgument(message))).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* Effect.logError("[ServerSync] Commit failed:", error);
              yield* Effect.promise(() =>
                vscodeApi.window.showErrorMessage(
                  `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }),
          ),
          Effect.ignore,
        ),
      );
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_REFRESH, () => {
      void vscodeApi.window
        .showInformationMessage("Reloading workspace from server...", "Reload")
        .then((selection) => {
          if (selection === "Reload") {
            window.location.reload();
          }
        });
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_REFRESH_HISTORY, () => {
      commitHistoryProvider.refresh();
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_REFRESH_FORK_HISTORY, () => {
      forkHistoryProvider.refresh();
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_VIEW_FORK_SOURCE, (hash) => {
      const parsed = Match.value(decodeStringArgument(hash)).pipe(
        Match.tags({ None: () => undefined, Some: ({ value }) => value }),
        Match.exhaustive,
      );
      if (parsed === undefined) return;
      // Navigate to the fork source playground
      const url = `/playgrounds/${parsed}`;
      runFork(Effect.log("[ServerSync] Opening fork source:", url));
      navigateTo(url);
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_VIEW_COMMIT, (commitId) => {
      const parsed = Match.value(decodeStringArgument(commitId)).pipe(
        Match.tags({ None: () => undefined, Some: ({ value }) => value }),
        Match.exhaustive,
      );
      if (parsed === undefined) return;
      runFork(
        Effect.tryPromise({
          try: () =>
            vscodeApi.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Loading commit diff...",
                cancellable: false,
              },
              () =>
                Effect.runPromiseWith(runtime)(
                  Effect.gen(function* () {
                    // Need to know which playground this commit belongs to
                    if (!currentPlaygroundHash) {
                      vscodeApi.window.showErrorMessage("No playground loaded");
                      return;
                    }

                    // Fetch diff from server - GET /playgrounds/:hash/commits/:commit_id/diff
                    const hash = currentPlaygroundHash;
                    const result = yield* call("apiPlaygrounds.getCommitDiff", (api) =>
                      api.apiPlaygrounds.getCommitDiff({
                        params: { hash, commit_id: parsed },
                      }),
                    ).pipe(
                      Effect.catch((error) =>
                        Effect.sync(() => {
                          vscodeApi.window.showErrorMessage(
                            `Failed to load commit diff: ${error.status} ${error.message}`,
                          );
                          return null;
                        }),
                      ),
                    );

                    if (!result) {
                      vscodeApi.window.showErrorMessage("Failed to load commit diff: no data");
                      return;
                    }

                    // Result is the diff object directly
                    const diff = result as {
                      readonly added: readonly {
                        readonly path: string;
                        readonly content?: string;
                        readonly oldContent?: string;
                      }[];
                      readonly modified: readonly {
                        readonly path: string;
                        readonly content?: string;
                        readonly oldContent?: string;
                      }[];
                      readonly deleted: readonly {
                        readonly path: string;
                        readonly content?: string;
                        readonly oldContent?: string;
                      }[];
                    };

                    runFork(Effect.log("[ServerSync] Viewing commit diff:", parsed));
                    runFork(
                      Effect.log("[ServerSync] Files changed:", {
                        added: diff.added.length,
                        modified: diff.modified.length,
                        deleted: diff.deleted.length,
                      }),
                    );

                    // Show quick pick for file selection
                    interface DiffFileItem extends vscode.QuickPickItem {
                      file: { path: string; content?: string; oldContent?: string };
                      type: "added" | "modified" | "deleted";
                    }

                    const items: DiffFileItem[] = [
                      ...diff.added.map((f) => ({
                        label: `$(diff-added) ${f.path}`,
                        description: "Added",
                        file: f,
                        type: "added" as const,
                      })),
                      ...diff.modified.map((f) => ({
                        label: `$(diff-modified) ${f.path}`,
                        description: "Modified",
                        file: f,
                        type: "modified" as const,
                      })),
                      ...diff.deleted.map((f) => ({
                        label: `$(diff-removed) ${f.path}`,
                        description: "Deleted",
                        file: f,
                        type: "deleted" as const,
                      })),
                    ];

                    if (items.length === 0) {
                      vscodeApi.window.showInformationMessage("No changes in this commit");
                      return;
                    }

                    const selected = yield* Effect.tryPromise({
                      try: () =>
                        vscodeApi.window.showQuickPick(items, {
                          placeHolder: `Select a file to view diff (${items.length} files changed)`,
                          matchOnDescription: true,
                        }),
                      catch: toServerSyncError,
                    });

                    if (!selected) {
                      return;
                    }

                    // Create virtual documents for diff view
                    const scheme = "server-sync-commit";

                    if (selected.type === "added") {
                      // Show new file (no diff needed, just open the file)
                      const uri = vscode.Uri.file(selected.file.path);
                      yield* Effect.tryPromise({
                        try: () => vscodeApi.commands.executeCommand(VSCODE_OPEN, uri),
                        catch: toServerSyncError,
                      });
                    } else if (selected.type === "deleted") {
                      // Show deleted file content (read-only)
                      vscodeApi.window.showInformationMessage(
                        `File was deleted: ${selected.file.path}`,
                      );
                    } else {
                      // Show diff for modified files
                      const leftUri = vscode.Uri.parse(`${scheme}:${selected.file.path}?old`);
                      const rightUri = vscode.Uri.file(selected.file.path);

                      // Register content provider for old version
                      const disposable = vscodeApi.workspace.registerTextDocumentContentProvider(
                        scheme,
                        {
                          provideTextDocumentContent(uri: vscode.Uri): string {
                            if (uri.query === "old") {
                              return selected.file.oldContent || "";
                            }
                            return "";
                          },
                        },
                      );

                      try {
                        yield* Effect.tryPromise({
                          try: () =>
                            vscodeApi.commands.executeCommand(
                              VSCODE_DIFF,
                              leftUri,
                              rightUri,
                              `${selected.file.path} (Commit ${parsed.substring(0, 8)}) ↔ Current`,
                            ),
                          catch: toServerSyncError,
                        });
                      } finally {
                        disposable.dispose();
                      }
                    }
                  }),
                ),
            ),
          catch: toServerSyncError,
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              runFork(Effect.logError("[ServerSync] Error viewing commit diff:", error));
              void vscodeApi.window.showErrorMessage(
                `Error: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          ),
          Effect.ignore,
        ),
      );
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_LOAD_COMMIT, (item) => {
      // Handle being called from context menu (CommitHistoryItem) or directly (string)
      const commitId =
        Option.getOrUndefined(decodeStringArgument(item)) ??
        Option.getOrUndefined(decodeCommandItem(item))?.id;

      if (!commitId) return;

      // Navigate to the commit URL - this will trigger the router
      // which will load the workspace via workspaceSwitcher
      if (!currentPlaygroundHash) {
        runFork(Effect.logWarning("[ServerSync] Cannot navigate to commit — no playground loaded"));
        return;
      }
      const url = `/playgrounds/${currentPlaygroundHash}/commits/${commitId}`;

      runFork(Effect.log("[ServerSync] Navigating to commit URL:", url));
      navigateTo(url);
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_RESTORE_COMMIT, (item) => {
      // Handle being called from context menu (CommitHistoryItem) or directly (string)
      const commitId =
        Option.getOrUndefined(decodeStringArgument(item)) ??
        Option.getOrUndefined(decodeCommandItem(item))?.id;

      if (!commitId) return;

      runFork(
        Effect.gen(function* () {
          const confirm = yield* Effect.tryPromise({
            try: () =>
              vscodeApi.window.showWarningMessage(
                "This will restore all files from this commit. Current changes will be overwritten. Continue?",
                "Restore",
                "Cancel",
              ),
            catch: toServerSyncError,
          });

          if (confirm !== "Restore") {
            return;
          }

          // Need to know which playground this commit belongs to
          if (!currentPlaygroundHash) {
            void vscodeApi.window.showErrorMessage("No playground loaded");
            return;
          }

          // Fetch commit - GET /playgrounds/:hash/commits/:commit_id
          const hash = currentPlaygroundHash;
          const commitOrNull = yield* call("apiPlaygrounds.getCommit", (api) =>
            api.apiPlaygrounds.getCommit({
              params: { hash, commit_id: commitId },
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                void vscodeApi.window.showErrorMessage(
                  `Failed to load commit: ${error.status} ${error.message}`,
                );
                return null;
              }),
            ),
          );

          if (!commitOrNull) {
            void vscodeApi.window.showErrorMessage("Commit not found");
            return;
          }

          const commitData = commitOrNull;

          yield* loadedWorkspace.replace(
            Effect.gen(function* () {
              const allFiles = yield* Effect.tryPromise({
                try: () => vscodeApi.workspace.findFiles("**/*", "**/node_modules/**"),
                catch: toServerSyncError,
              });

              yield* Effect.forEach(allFiles, (file) =>
                Effect.tryPromise({
                  try: () => vscodeApi.workspace.fs.delete(file),
                  catch: toServerSyncError,
                }).pipe(
                  Effect.catch((err) => Effect.logWarning(`Failed to delete ${file.path}:`, err)),
                ),
              );

              // Restore files from commit
              yield* Effect.forEach(commitData.files, (file) =>
                Effect.gen(function* () {
                  const uri = vscode.Uri.file(file.path);
                  const content = new TextEncoder().encode(file.content);
                  const dirUri = vscode.Uri.file(
                    file.path.substring(0, file.path.lastIndexOf("/")),
                  );

                  yield* Effect.tryPromise({
                    try: () => vscodeApi.workspace.fs.createDirectory(dirUri),
                    catch: toServerSyncError,
                  }).pipe(Effect.ignore);

                  yield* Effect.tryPromise({
                    try: () => vscodeApi.workspace.fs.writeFile(uri, content),
                    catch: toServerSyncError,
                  });
                }).pipe(
                  Effect.catch((err) =>
                    Effect.logWarning(`Failed to restore file ${file.path}:`, err),
                  ),
                ),
              );
            }),
          );

          void vscodeApi.window.showInformationMessage(
            `Restored ${commitData.files.length} files from commit`,
          );

          // Update current commit tracking
          currentCommitId = commitId;

          // Update baseline to restored commit
          baselineFiles.clear();
          commitData.files.forEach((f) => baselineFiles.set(f.path, f.content));

          // Clear changed files (restored commit is the new baseline)
          changedFiles.clear();
          updateSCMView();

          // Refresh quick diff decorations to show comparison with restored commit
          yield* refreshQuickDiff();

          // Refresh tree to show the active commit
          commitHistoryProvider.refresh();
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              void vscodeApi.window.showErrorMessage(
                `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          ),
          Effect.ignore,
        ),
      );
    });

    /**
     * Command: server-sync.workspaceLoaded
     * Called by workspaceSwitcher when a workspace is loaded
     * Updates the SCM baseline and current commit tracking
     */
    yield* vscodeService.registerCommand(SERVER_SYNC_WORKSPACE_LOADED, (data) => {
      const d = Match.value(decodeWorkspaceLoaded(data)).pipe(
        Match.tags({ None: () => undefined, Some: ({ value }) => value }),
        Match.exhaustive,
      );
      if (d === undefined) return;

      runFork(
        Effect.log(
          "[ServerSync] Workspace loaded notification:",
          d.commitId,
          d.playgroundHash,
          `${d.files.length} files`,
        ),
      );

      // Update current commit and playground tracking
      currentCommitId = d.commitId;
      if (d.playgroundHash) {
        currentPlaygroundHash = d.playgroundHash;
      }

      // Update baseline to loaded workspace
      baselineFiles.clear();
      d.files.forEach((f) => baselineFiles.set(f.path, f.content));

      // Clear changed files (loaded workspace is the new baseline)
      changedFiles.clear();
      updateSCMView();

      runFork(
        Effect.gen(function* () {
          // Refresh quick diff decorations to show comparison with loaded workspace
          yield* refreshQuickDiff();

          // Refresh tree to show the active commit
          commitHistoryProvider.refresh();

          // Refresh fork history
          forkHistoryProvider.refresh();

          yield* Effect.log(
            "[ServerSync] Baseline updated to commit:",
            currentCommitId,
            "playground:",
            currentPlaygroundHash,
          );

          // Update status bar
          yield* updateStatusBar();
        }).pipe(Effect.ignore),
      );
    });

    // Register baseline content provider for quick diff
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.registerTextDocumentContentProvider(
          BASELINE_SCHEME,
          baselineContentProvider,
        ),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    // Create SCM provider
    const scm = yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.scm.createSourceControl("server-sync", "Server Sync", workspaceFolder.uri),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    scm.inputBox.placeholder = "Commit message (optional)";
    scm.acceptInputCommand = {
      command: SERVER_SYNC_COMMIT,
      title: "Sync to Server",
    };
    scm.actionButton = {
      command: {
        command: SERVER_SYNC_COMMIT,
        title: "Sync to Server",
      },
      enabled: true,
    };

    // Add quick diff provider to show inline diff decorations (gutter decorations)
    // This shows green/red marks in the editor gutter comparing current files against the baseline
    scm.quickDiffProvider = quickDiffProvider;

    // Track total commits for status bar display
    let totalCommits = 0;
    let currentCommitIndex = 0;

    /**
     * Update status bar to show current commit position
     */
    const updateStatusBar = Effect.fnUntraced(function* () {
      if (!currentPlaygroundHash) {
        scm.statusBarCommands = undefined;
        return;
      }

      const hash = currentPlaygroundHash;

      const commits = yield* call("apiPlaygrounds.listCommits", (api) =>
        api.apiPlaygrounds.listCommits({ params: { hash } }),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            scm.statusBarCommands = undefined;
            return null;
          }),
        ),
      );
      if (!commits) return;

      totalCommits = commits.length;
      currentCommitIndex = commits.findIndex((c) => c.id === currentCommitId);

      if (currentCommitIndex === -1) {
        currentCommitIndex = 0;
      }

      // Position from newest (commits are ordered desc by date)
      const position = currentCommitIndex + 1;

      scm.statusBarCommands = [
        {
          command: SERVER_SYNC_CHECKOUT_VERSION,
          title: `↕ Version ${position}/${totalCommits}`,
          tooltip: "Click to checkout another version",
        },
      ];
    });

    // Register checkout version command
    yield* vscodeService.registerCommand(SERVER_SYNC_CHECKOUT_VERSION, () => {
      runFork(
        Effect.gen(function* () {
          if (!currentPlaygroundHash) {
            void vscodeApi.window.showErrorMessage("No playground loaded");
            return;
          }

          const hash = currentPlaygroundHash;

          const commits = yield* call("apiPlaygrounds.listCommits", (api) =>
            api.apiPlaygrounds.listCommits({ params: { hash } }),
          ).pipe(
            Effect.catch(() => {
              void vscodeApi.window.showErrorMessage("Failed to load commits");
              return Effect.succeed(null);
            }),
          );

          if (!commits) return;

          interface VersionQuickPickItem extends vscode.QuickPickItem {
            commitId: string;
          }

          const items: VersionQuickPickItem[] = commits.map((commit, index) => ({
            label: `${commit.id === currentCommitId ? "✓ " : ""}Version ${index + 1}`,
            description: commit.message || `Commit ${commit.id.substring(0, 8)}`,
            detail: `${commit.username || "Unknown"} • ${DateTime.formatLocal(DateTime.makeUnsafe(commit.timestamp))}`,
            commitId: commit.id,
          }));

          const selected = yield* Effect.tryPromise({
            try: () =>
              vscodeApi.window.showQuickPick(items, {
                placeHolder: `Select a version to checkout (currently at ${currentCommitIndex + 1}/${totalCommits})`,
                matchOnDescription: true,
                matchOnDetail: true,
              }),
            catch: toServerSyncError,
          });

          if (selected && selected.commitId !== currentCommitId && currentPlaygroundHash) {
            // Navigate to the selected commit
            const url = `/playgrounds/${currentPlaygroundHash}/commits/${selected.commitId}`;
            navigateTo(url);
          }
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* Effect.logError("[ServerSync] Error in checkout version:", error);
              yield* Effect.promise(() =>
                vscodeApi.window.showErrorMessage("Failed to load versions"),
              );
            }),
          ),
          Effect.ignore,
        ),
      );
    });

    // Create resource group for changed files
    const workingTreeGroup = yield* Effect.acquireRelease(
      Effect.sync(() => scm.createResourceGroup("working-tree", "Changes")),
      (d) => Effect.sync(() => d.dispose()),
    );

    // Watch for file changes
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.onDidChangeTextDocument((event) => {
          runFork(markFileAsChanged(event.document.uri));
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.onDidCreateFiles((event) => {
          event.files.forEach((uri) => {
            runFork(markFileAsChanged(uri));
          });
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.onDidDeleteFiles((event) => {
          event.files.forEach((uri) => {
            // For deleted files, check if they existed in baseline
            if (baselineFiles.has(uri.path)) {
              changedFiles.set(uri.toString(), uri);
              updateSCMView();
              runFork(Effect.log(`[ServerSync] File deleted: ${uri.path}`));
            }
          });
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.onDidRenameFiles((event) => {
          event.files.forEach((file) => {
            runFork(markFileAsChanged(file.oldUri));
            runFork(markFileAsChanged(file.newUri));
          });
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    // Initialize baseline from workspace (start with clean state)
    // On first load, we'll compare against current state (so initially nothing is "changed")
    const allFiles = yield* Effect.tryPromise({
      try: () => vscodeApi.workspace.findFiles("**/*", "**/node_modules/**"),
      catch: toServerSyncError,
    });

    yield* Effect.forEach(allFiles, (fileUri) =>
      Effect.tryPromise({
        try: () => vscodeApi.workspace.fs.readFile(fileUri),
        catch: toServerSyncError,
      }).pipe(
        Effect.tap((content) =>
          Effect.sync(() => {
            const textContent = new TextDecoder().decode(content);
            baselineFiles.set(fileUri.path, textContent);
          }),
        ),
        Effect.catch((err) =>
          Effect.logWarning(`[ServerSync] Failed to read initial file ${fileUri.path}:`, err),
        ),
      ),
    );

    // Start with empty changed files (like Git after clone/init)
    updateSCMView();

    yield* Effect.log("[ServerSync] Initialized successfully");
  }).pipe(Effect.withSpan("feature.serverSync")),
);
