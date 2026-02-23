/**
 * Server Sync Feature
 * Provides workspace persistence by syncing files to the server via SCM interface
 */

import * as vscode from "vscode";
import type { SourceControlResourceState, TreeDataProvider, TreeItem } from "vscode";
import { Effect, Layer, Option, pipe } from "effect";
import {
  ApiRequestError,
  httpApiCreatePlayground,
  httpApiCreatePlaygroundCommit,
  httpApiGetPlayground,
  httpApiGetPlaygroundCommit,
  httpApiGetPlaygroundCommitDiff,
  httpApiListPlaygroundCommits,
  httpApiMe,
} from "../httpapi-client";
import { playgroundRoute } from "../shared/routes";
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

const toError = (error: unknown): Error =>
  new Error(error instanceof Error ? error.message : String(error));

export const ServerSyncFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    const { runFork } = yield* Workbench;
    const vscodeApi = vscodeService.api;

    console.log("[ServerSync] API received, checking workspace...");
    const workspaceFolder = vscodeApi.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.warn("[ServerSync] No workspace folder found, skipping initialization");
      return;
    }

    console.log("[ServerSync] Initializing workspace sync...");

    const changedFiles = new Map<string, vscode.Uri>(); // Track changed files
    let currentCommitId: string | null = null; // Track the currently loaded commit
    let currentPlaygroundHash: string | null = null; // Track the currently loaded playground hash
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
    async function refreshQuickDiff() {
      const allFiles = await vscodeApi.workspace.findFiles("**/*", "**/node_modules/**");
      allFiles.forEach((fileUri) => {
        // Fire change event to refresh gutter decorations
        baselineContentProvider.fireChange(vscode.Uri.parse(`${BASELINE_SCHEME}:${fileUri.path}`));
      });
    }

    /**
     * Scan workspace and collect all files
     */
    async function scanWorkspace(): Promise<Array<{ path: string; content: string }>> {
      try {
        // Find all files (excluding common ignore patterns)
        const allFiles = await vscodeApi.workspace.findFiles("**/*");

        const files = await allFiles.reduce(
          async (accPromise, fileUri) => {
            const acc = await accPromise;
            try {
              const content = await vscodeApi.workspace.fs.readFile(fileUri);
              const textContent = new TextDecoder().decode(content);
              acc.push({ path: fileUri.path, content: textContent });
            } catch (err) {
              console.warn(`[ServerSync] Failed to read file ${fileUri.path}:`, err);
            }
            return acc;
          },
          Promise.resolve([] as Array<{ path: string; content: string }>),
        );

        console.log(`[ServerSync] Scanned workspace: ${files.length} files`);
        return files;
      } catch (err) {
        console.error("[ServerSync] Failed to scan workspace:", err);
        throw err;
      }
    }

    /** Sentinel thrown to break out of withProgress before showing sign-in prompt */
    class SignInRequired extends Error {}

    /**
     * Commit workspace to server
     */
    async function commitWorkspace(message?: unknown) {
      try {
        // Show progress
        await vscodeApi.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Syncing workspace to server...",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Saving files..." });

            // Flush all unsaved editor buffers to the virtual filesystem
            // so scanWorkspace() picks up the latest content
            await vscodeApi.workspace.saveAll(false);

            progress.report({ message: "Scanning files..." });

            // Scan all files
            const files = await scanWorkspace();

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
              (typeof message === "string" ? message : undefined) ||
              scm.inputBox.value ||
              `Workspace snapshot at ${new Date().toISOString()}`;

            // Generate unique name (slug) for the playground
            // Format: workspace_YYYYMMDD_HHMMSS_milliseconds
            const now = new Date();
            const playgroundName = `workspace_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}_${now.getMilliseconds()}`;

            // Send to server using Eden Treaty for type safety
            console.log("[ServerSync] Sending commit request:", {
              playground_hash: currentPlaygroundHash,
              fileCount: files.length,
              message: commitMessage,
            });

            // Check if user is authenticated by querying the server
            // We check with the server instead of just the local auth provider
            // because the session cookie is the source of truth for authentication
            let isAuthenticated = false;
            try {
              const me = (await Effect.runPromise(httpApiMe)) as {
                user?: { id?: string; username?: string } | null;
              };
              isAuthenticated = !!me?.user?.id;
              console.log("[ServerSync] Auth check:", {
                isAuthenticated,
                userId: me?.user?.id,
                username: me?.user?.username,
              });
            } catch (error) {
              console.warn("[ServerSync] Failed to check auth status:", error);
            }

            // Strategy:
            // - Authenticated users: Save to server (update existing or create new)
            // - Anonymous users: Encode workspace as base64 URL (no server storage)
            //   Falls back to server-side anonymous save if payload > 16KB

            if (!isAuthenticated) {
              // Encode workspace as base64url for anonymous sharing
              // (base64url replaces +→- /→_ and strips = padding to be URL-safe)
              const payload = JSON.stringify({ files, activeFile });
              const encoded = btoa(unescape(encodeURIComponent(payload)))
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, "");

              if (encoded.length <= 8192) {
                const shareUrl = `${window.location.origin}/s/${encoded}`;
                await navigator.clipboard.writeText(shareUrl);
                vscodeApi.window.showInformationMessage(
                  "Shareable link copied to clipboard! Sign in for shorter, permanent URLs.",
                );
                return;
              }

              // Payload too large for URL — signal to prompt sign-in after progress closes
              throw new SignInRequired();
            }

            let result: unknown;
            try {
              result = await Effect.runPromise(
                currentPlaygroundHash && isAuthenticated
                  ? httpApiCreatePlaygroundCommit(currentPlaygroundHash, {
                      message: commitMessage,
                      files,
                      activeFile,
                    })
                  : httpApiCreatePlayground({
                      name: playgroundName,
                      message: commitMessage,
                      description: "New playground",
                      files,
                      activeFile,
                    }),
              );
            } catch (error) {
              console.error("[ServerSync] Commit failed:", error);

              if (error instanceof ApiRequestError && error.status === 401) {
                const choice = await vscodeApi.window.showWarningMessage(
                  "Your session has expired. Please sign in again to sync.",
                  "Sign In",
                  "Cancel",
                );

                if (choice === "Sign In") {
                  try {
                    await vscodeApi.authentication.getSession("github-auth", [], {
                      createIfNone: true,
                      forceNewSession: true,
                    });
                    vscodeApi.window.showInformationMessage(
                      "Signed in successfully. Please try syncing again.",
                    );
                  } catch {
                    vscodeApi.window.showErrorMessage("Authentication failed. Please try again.");
                  }
                }
                return;
              }

              throw new Error(
                `Failed to commit workspace: ${error instanceof ApiRequestError ? `${error.status} ${JSON.stringify(error.value)}` : String(error)}`,
              );
            }

            if (!result) {
              throw new Error("Failed to commit workspace: no response data");
            }

            // Type-safe access (error case already handled above)
            const commitResult = result as unknown as {
              commit_id: string;
              playground_hash: string;
              forked?: boolean;
            };

            // API returns { commit_id, playground_hash, parent_id, message, created_at }
            if (!commitResult.commit_id) {
              throw new Error("Failed to commit workspace");
            }

            console.log("[ServerSync] Commit successful:", commitResult);
            console.log(
              "[ServerSync] Files committed:",
              files.map((f) => ({ path: f.path, size: f.content.length })),
            );

            // Check if playground hash changed (new playground created)
            const playgroundHashChanged = currentPlaygroundHash !== commitResult.playground_hash;
            const wasForked = commitResult.forked === true;

            // Update current commit and playground tracking
            currentCommitId = commitResult.commit_id;
            if (commitResult.playground_hash) {
              currentPlaygroundHash = commitResult.playground_hash;
            }

            // Navigate to the playground URL if hash changed
            // This happens for:
            // - First sync (no previous hash)
            // - Anonymous user syncing (always creates new playground)
            // - Authenticated user forking (anonymous or other user's playground)
            if (playgroundHashChanged && commitResult.playground_hash) {
              console.log(
                "[ServerSync] Playground hash changed - updating URL to:",
                commitResult.playground_hash,
                wasForked ? "(forked)" : isAuthenticated ? "(first sync)" : "(anonymous snapshot)",
              );

              // Update URL to reflect the new playground
              const path = playgroundRoute.interpolate({
                playgroundId: commitResult.playground_hash,
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
            await refreshQuickDiff();

            // Show success message with appropriate context
            if (wasForked) {
              // Authenticated user forked the playground
              vscodeApi.window.showInformationMessage(
                `Playground forked: ${files.length} file(s) saved. You now own this copy and can continue making commits.`,
              );
            } else if (!isAuthenticated && playgroundHashChanged) {
              // Anonymous user created a new snapshot
              const action = await vscodeApi.window.showInformationMessage(
                `Anonymous snapshot created: ${files.length} file(s) saved. Each sync creates a new shareable link.`,
                "Sign In for Continuous Sync",
              );

              if (action === "Sign In for Continuous Sync") {
                try {
                  await vscodeApi.authentication.getSession("github-auth", [], {
                    createIfNone: true,
                  });
                  vscodeApi.window.showInformationMessage(
                    "Signed in! Future syncs will update this playground.",
                  );
                } catch {
                  // User cancelled, ignore
                }
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
            void updateStatusBar();
          },
        );
      } catch (err) {
        if (err instanceof SignInRequired) {
          const choice = await vscodeApi.window.showWarningMessage(
            "Workspace is too large to share anonymously. Sign in to save to the server.",
            "Sign In",
            "Cancel",
          );
          if (choice === "Sign In") {
            try {
              await vscodeApi.authentication.getSession("github-auth", [], {
                createIfNone: true,
              });
            } catch {
              // User cancelled sign-in
            }
          }
          return;
        }
        throw err;
      }
    }

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
    async function markFileAsChanged(uri: vscode.Uri) {
      const key = uri.toString();

      try {
        // Read current file content
        const content = await vscodeApi.workspace.fs.readFile(uri);
        const textContent = new TextDecoder().decode(content);

        // Compare with baseline
        const baselineContent = baselineFiles.get(uri.path);

        if (baselineContent === textContent) {
          // File matches baseline - remove from changed list if present
          if (changedFiles.has(key)) {
            changedFiles.delete(key);
            updateSCMView();
            console.log(`[ServerSync] File reverted to baseline: ${uri.path}`);
          }
        } else {
          // File is different from baseline - mark as changed
          if (!changedFiles.has(key)) {
            changedFiles.set(key, uri);
            updateSCMView();
            console.log(`[ServerSync] File changed: ${uri.path}`);
          }
        }
      } catch {
        // File might be deleted or unreadable
        const baselineContent = baselineFiles.get(uri.path);
        if (baselineContent !== undefined) {
          // File existed in baseline but now deleted/unreadable - mark as changed
          if (!changedFiles.has(key)) {
            changedFiles.set(key, uri);
            updateSCMView();
            console.log(`[ServerSync] File deleted: ${uri.path}`);
          }
        }
      }
    }

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
        treeItem.description = new Date(element.timestamp).toLocaleString();
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

      async getChildren(element?: CommitHistoryItem): Promise<CommitHistoryItem[]> {
        if (element) {
          // No children for commits
          return [];
        }

        // If no playground is loaded, show empty list
        if (!currentPlaygroundHash) {
          console.log("[ServerSync] No playground loaded, commit history is empty");
          return [];
        }

        try {
          // Fetch commits from server - GET /playgrounds/:hash/commits
          const commits = await Effect.runPromise(
            httpApiListPlaygroundCommits(currentPlaygroundHash),
          );

          if (!Array.isArray(commits)) return [];

          console.log(
            `[ServerSync] Showing ${commits.length} commits for playground ${currentPlaygroundHash}`,
          );

          // API returns array directly: [{ id, message, timestamp, parent_id, user_id }, ...]
          return commits.map((c) => ({
            id: c.id,
            message: c.message,
            timestamp: String(c.timestamp),
            username: c.username,
          }));
        } catch (err) {
          console.error("[ServerSync] Error loading commits:", err);
          return [];
        }
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

      async getChildren(element?: ForkHistoryItem): Promise<ForkHistoryItem[]> {
        if (element) {
          // No children for fork items
          return [];
        }

        // If no playground is loaded, show empty list
        if (!currentPlaygroundHash) {
          return [];
        }

        try {
          // Helper to break TypeScript's circular inference in the while loop
          const fetchPlayground = (hash: string) =>
            Effect.runPromise(httpApiGetPlayground(hash)) as Promise<unknown>;

          // Build fork chain by traversing fork_of references
          const chain: ForkHistoryItem[] = [];
          let currentHash: string | null = currentPlaygroundHash;

          while (currentHash) {
            const playground = await fetchPlayground(currentHash);
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
                Option.fromNullable(pg.user),
                Option.flatMap((user) => Option.fromNullable(user.username)),
                Option.getOrUndefined,
              ),
              isCurrent: pg.hash === currentPlaygroundHash,
            });

            currentHash = pipe(
              Option.fromNullable(pg.fork_of),
              Option.flatMap((forkOf) => Option.fromNullable(forkOf.hash)),
              Option.getOrNull,
            );
          }

          // Show from oldest to newest (fork source first)
          this.forkChain = chain.reverse();

          console.log(`[ServerSync] Fork history: ${this.forkChain.length} items`);

          return this.forkChain;
        } catch (err) {
          console.error("[ServerSync] Error loading fork history:", err);
          return [];
        }
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
        Effect.tryPromise({
          try: () => commitWorkspace(message),
          catch: toError,
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              void vscodeApi.window.showErrorMessage(
                `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          ),
          Effect.catchAll(() => Effect.void),
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

    yield* vscodeService.registerCommand(SERVER_SYNC_VIEW_FORK_SOURCE, (hash: unknown) => {
      if (typeof hash !== "string") return;
      // Navigate to the fork source playground
      const url = `/playgrounds/${hash}`;
      console.log("[ServerSync] Opening fork source:", url);

      if (window.navigation) {
        window.navigation.navigate(url);
      } else {
        window.location.href = url;
      }
    });

    yield* vscodeService.registerCommand(SERVER_SYNC_VIEW_COMMIT, (commitId: unknown) => {
      if (typeof commitId !== "string") return;
      runFork(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              vscodeApi.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "Loading commit diff...",
                  cancellable: false,
                },
                async () => {
                  // Need to know which playground this commit belongs to
                  if (!currentPlaygroundHash) {
                    vscodeApi.window.showErrorMessage("No playground loaded");
                    return;
                  }

                  // Fetch diff from server - GET /playgrounds/:hash/commits/:commit_id/diff
                  let result: unknown;
                  try {
                    result = await Effect.runPromise(
                      httpApiGetPlaygroundCommitDiff(currentPlaygroundHash, commitId),
                    );
                  } catch (error) {
                    vscodeApi.window.showErrorMessage(
                      `Failed to load commit diff: ${error instanceof ApiRequestError ? `${error.status} ${JSON.stringify(error.value)}` : String(error)}`,
                    );
                    return;
                  }

                  if (!result) {
                    vscodeApi.window.showErrorMessage("Failed to load commit diff: no data");
                    return;
                  }

                  // Result is the diff object directly
                  const diff = result as {
                    added: Array<{ path: string; content?: string; oldContent?: string }>;
                    modified: Array<{ path: string; content?: string; oldContent?: string }>;
                    deleted: Array<{ path: string; content?: string; oldContent?: string }>;
                  };

                  console.log("[ServerSync] Viewing commit diff:", commitId);
                  console.log("[ServerSync] Files changed:", {
                    added: diff.added.length,
                    modified: diff.modified.length,
                    deleted: diff.deleted.length,
                  });

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

                  const selected = await vscodeApi.window.showQuickPick(items, {
                    placeHolder: `Select a file to view diff (${items.length} files changed)`,
                    matchOnDescription: true,
                  });

                  if (!selected) {
                    return;
                  }

                  // Create virtual documents for diff view
                  const scheme = "server-sync-commit";

                  if (selected.type === "added") {
                    // Show new file (no diff needed, just open the file)
                    const uri = vscode.Uri.file(selected.file.path);
                    await vscodeApi.commands.executeCommand(VSCODE_OPEN, uri);
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
                      await vscodeApi.commands.executeCommand(
                        VSCODE_DIFF,
                        leftUri,
                        rightUri,
                        `${selected.file.path} (Commit ${commitId.substring(0, 8)}) ↔ Current`,
                      );
                    } finally {
                      disposable.dispose();
                    }
                  }
                },
              ),
            catch: toError,
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              console.error("[ServerSync] Error viewing commit diff:", error);
              void vscodeApi.window.showErrorMessage(
                `Error: ${error instanceof Error ? error.message : String(error)}`,
              );
            }),
          ),
          Effect.catchAll(() => Effect.void),
        ),
      );
    });

    yield* vscodeService.registerCommand(
      SERVER_SYNC_LOAD_COMMIT,
      (item: unknown) => {
        // Handle being called from context menu (CommitHistoryItem) or directly (string)
        const commitId =
          typeof item === "string"
            ? item
            : item !== null && typeof item === "object" && "id" in item && typeof item.id === "string"
              ? item.id
              : null;

        if (!commitId) return;

        // Navigate to the commit URL - this will trigger the router
        // which will load the workspace via workspaceSwitcher
        if (!currentPlaygroundHash) {
          console.warn("[ServerSync] Cannot navigate to commit — no playground loaded");
          return;
        }
        const url = `/playgrounds/${currentPlaygroundHash}/commits/${commitId}`;

        console.log("[ServerSync] Navigating to commit URL:", url);

        if (window.navigation) {
          window.navigation.navigate(url);
        } else {
          window.location.href = url;
        }
      },
    );

    yield* vscodeService.registerCommand(
      SERVER_SYNC_RESTORE_COMMIT,
      (item: unknown) => {
        // Handle being called from context menu (CommitHistoryItem) or directly (string)
        const commitId =
          typeof item === "string"
            ? item
            : item !== null && typeof item === "object" && "id" in item && typeof item.id === "string"
              ? item.id
              : null;

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
              catch: toError,
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
            const commitOrNull = yield* httpApiGetPlaygroundCommit(
              currentPlaygroundHash,
              commitId,
            ).pipe(
              Effect.map((v) => v as unknown),
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  void vscodeApi.window.showErrorMessage(
                    `Failed to load commit: ${error instanceof ApiRequestError ? `${error.status} ${JSON.stringify(error.value)}` : String(error)}`,
                  );
                  return null as unknown;
                }),
              ),
            );

            if (!commitOrNull) {
              void vscodeApi.window.showErrorMessage("Commit not found");
              return;
            }

            const commit: unknown = commitOrNull;

            const commitData = commit as {
              files: Array<{ path: string; content: string }>;
            };

            // Delete all existing files first
            const allFiles = yield* Effect.tryPromise({
              try: () => vscodeApi.workspace.findFiles("**/*", "**/node_modules/**"),
              catch: toError,
            });

            yield* Effect.forEach(allFiles, (file) =>
              Effect.tryPromise({
                try: () => vscodeApi.workspace.fs.delete(file),
                catch: toError,
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    console.warn(`Failed to delete ${file.path}:`, err);
                  }),
                ),
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
                  catch: toError,
                }).pipe(Effect.catchAll(() => Effect.void));

                yield* Effect.tryPromise({
                  try: () => vscodeApi.workspace.fs.writeFile(uri, content),
                  catch: toError,
                });
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => {
                    console.warn(`Failed to restore file ${file.path}:`, err);
                  }),
                ),
              ),
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
            yield* Effect.tryPromise({ try: () => refreshQuickDiff(), catch: toError });

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
            Effect.catchAll(() => Effect.void),
          ),
        );
      },
    );

    /**
     * Command: server-sync.workspaceLoaded
     * Called by workspaceSwitcher when a workspace is loaded
     * Updates the SCM baseline and current commit tracking
     */
    yield* vscodeService.registerCommand(
      SERVER_SYNC_WORKSPACE_LOADED,
      (data: unknown) => {
        const d = data as {
          commitId: string;
          playgroundHash: string;
          files: Array<{ path: string; content: string }>;
        };

        console.log(
          "[ServerSync] Workspace loaded notification:",
          d.commitId,
          d.playgroundHash,
          `${d.files.length} files`,
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
            yield* Effect.tryPromise({ try: () => refreshQuickDiff(), catch: toError });

            // Refresh tree to show the active commit
            commitHistoryProvider.refresh();

            // Refresh fork history
            forkHistoryProvider.refresh();

            console.log(
              "[ServerSync] Baseline updated to commit:",
              currentCommitId,
              "playground:",
              currentPlaygroundHash,
            );

            // Update status bar
            yield* Effect.tryPromise({ try: () => updateStatusBar(), catch: toError });
          }).pipe(Effect.catchAll(() => Effect.void)),
        );
      },
    );

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
    async function updateStatusBar() {
      if (!currentPlaygroundHash) {
        scm.statusBarCommands = undefined;
        return;
      }

      try {
        // Fetch commits to determine position
        let commits;
        try {
          commits = await Effect.runPromise(
            httpApiListPlaygroundCommits(currentPlaygroundHash),
          );
        } catch {
          scm.statusBarCommands = undefined;
          return;
        }

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
      } catch (err) {
        console.error("[ServerSync] Error updating status bar:", err);
        scm.statusBarCommands = undefined;
      }
    }

    // Register checkout version command
    yield* vscodeService.registerCommand(SERVER_SYNC_CHECKOUT_VERSION, () => {
      runFork(
        Effect.gen(function* () {
          if (!currentPlaygroundHash) {
            void vscodeApi.window.showErrorMessage("No playground loaded");
            return;
          }

          const commits = yield* httpApiListPlaygroundCommits(currentPlaygroundHash).pipe(
            Effect.catchAll(() => {
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
            detail: `${commit.username || "Unknown"} • ${new Date(commit.timestamp).toLocaleString()}`,
            commitId: commit.id,
          }));

          const selected = yield* Effect.tryPromise({
            try: () =>
              vscodeApi.window.showQuickPick(items, {
                placeHolder: `Select a version to checkout (currently at ${currentCommitIndex + 1}/${totalCommits})`,
                matchOnDescription: true,
                matchOnDetail: true,
              }),
            catch: toError,
          });

          if (selected && selected.commitId !== currentCommitId && currentPlaygroundHash) {
            // Navigate to the selected commit
            const url = `/playgrounds/${currentPlaygroundHash}/commits/${selected.commitId}`;
            if (window.navigation) {
              window.navigation.navigate(url);
            } else {
              window.location.href = url;
            }
          }
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              console.error("[ServerSync] Error in checkout version:", error);
              void vscodeApi.window.showErrorMessage("Failed to load versions");
            }),
          ),
          Effect.catchAll(() => Effect.void),
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
          void markFileAsChanged(event.document.uri);
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.onDidCreateFiles((event) => {
          event.files.forEach((uri) => {
            void markFileAsChanged(uri);
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
              console.log(`[ServerSync] File deleted: ${uri.path}`);
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
            void markFileAsChanged(file.oldUri);
            void markFileAsChanged(file.newUri);
          });
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    // Initialize baseline from workspace (start with clean state)
    // On first load, we'll compare against current state (so initially nothing is "changed")
    const allFiles = yield* Effect.tryPromise({
      try: () => vscodeApi.workspace.findFiles("**/*", "**/node_modules/**"),
      catch: toError,
    });

    yield* Effect.forEach(allFiles, (fileUri) =>
      Effect.tryPromise({
        try: () => vscodeApi.workspace.fs.readFile(fileUri),
        catch: toError,
      }).pipe(
        Effect.tap((content) =>
          Effect.sync(() => {
            const textContent = new TextDecoder().decode(content);
            baselineFiles.set(fileUri.path, textContent);
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            console.warn(`[ServerSync] Failed to read initial file ${fileUri.path}:`, err);
          }),
        ),
      ),
    );

    // Start with empty changed files (like Git after clone/init)
    updateSCMView();

    console.log("[ServerSync] Initialized successfully");
  }).pipe(Effect.withSpan("feature.serverSync")),
);
