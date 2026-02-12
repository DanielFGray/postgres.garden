/**
 * Server Sync Feature
 * Provides workspace persistence by syncing files to the server via SCM interface
 */

import * as vscode from "vscode";
import type {
  SourceControlResourceState,
  TreeDataProvider,
  TreeItem,
} from "vscode";
import {
  ExtensionHostKind,
  registerExtension,
} from "@codingame/monaco-vscode-api/extensions";
import { api } from "../api-client";
import { router } from "./router";
import { replaceTo } from "../navigation";
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

// eslint-disable-next-line @typescript-eslint/unbound-method
const { getApi } = registerExtension(
  {
    name: "server-sync",
    publisher: "postgres-garden",
    engines: {
      vscode: "*",
    },
    version: "1.0.0",
    enabledApiProposals: ["scmActionButton"],
    contributes: {
      views: {
        scm: [
          {
            id: SERVER_SYNC_COMMIT_HISTORY,
            name: "Commit History",
          },
          {
            id: SERVER_SYNC_FORK_HISTORY,
            name: "Fork History",
          },
        ],
      },
      commands: [
        {
          command: SERVER_SYNC_COMMIT,
          title: "Server Sync: Commit Workspace",
          icon: "$(cloud-upload)",
        },
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
        {
          command: SERVER_SYNC_VIEW_COMMIT,
          title: "View Commit Diff",
        },
        {
          command: SERVER_SYNC_LOAD_COMMIT,
          title: "Load Commit",
          icon: "$(folder-opened)",
        },
        {
          command: SERVER_SYNC_RESTORE_COMMIT,
          title: "Restore from Commit",
          icon: "$(history)",
        },
        {
          command: SERVER_SYNC_CHECKOUT_VERSION,
          title: "Checkout Version",
          icon: "$(git-branch)",
        },
        {
          command: SERVER_SYNC_VIEW_FORK_SOURCE,
          title: "View Fork Source",
          icon: "$(repo-forked)",
        },
        {
          command: SERVER_SYNC_REFRESH_FORK_HISTORY,
          title: "Server Sync: Refresh Fork History",
          icon: "$(refresh)",
        },
      ],
      menus: {
        "view/title": [
          {
            command: SERVER_SYNC_REFRESH_HISTORY,
            when: "view == serverSync.commitHistory",
            group: "navigation",
          },
          {
            command: SERVER_SYNC_REFRESH_FORK_HISTORY,
            when: "view == serverSync.forkHistory",
            group: "navigation",
          },
        ],
        "view/item/context": [
          {
            command: SERVER_SYNC_LOAD_COMMIT,
            when: "view == serverSync.commitHistory && viewItem == commit",
            group: "inline",
          },
          {
            command: SERVER_SYNC_VIEW_FORK_SOURCE,
            when: "view == serverSync.forkHistory && viewItem == fork",
            group: "inline",
          },
        ],
      },
    },
  },
  ExtensionHostKind.LocalProcess,
  {
    system: true, // Required for API proposals
  },
);

console.log("[ServerSync] Extension registered, waiting for API...");

void getApi()
  .then(async (vscode) => {
    console.log("[ServerSync] API received, checking workspace...");
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder == null) {
      console.warn(
        "[ServerSync] No workspace folder found, skipping initialization",
      );
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
    class BaselineContentProvider
      implements vscode.TextDocumentContentProvider {
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
      const allFiles = await vscode.workspace.findFiles(
        "**/*",
        "**/node_modules/**",
      );
      for (const fileUri of allFiles) {
        // Fire change event to refresh gutter decorations
        baselineContentProvider.fireChange(
          vscode.Uri.parse(`${BASELINE_SCHEME}:${fileUri.path}`),
        );
      }
    }

    /**
     * Scan workspace and collect all files
     */
    async function scanWorkspace(): Promise<
      Array<{ path: string; content: string }>
    > {
      try {
        // Find all files (excluding common ignore patterns)
        const allFiles = await vscode.workspace.findFiles("**/*");

        const files: Array<{ path: string; content: string }> = [];

        for (const fileUri of allFiles) {
          try {
            // Read file content
            const content = await vscode.workspace.fs.readFile(fileUri);
            const textContent = new TextDecoder().decode(content);

            files.push({
              path: fileUri.path,
              content: textContent,
            });
          } catch (err) {
            console.warn(
              `[ServerSync] Failed to read file ${fileUri.path}:`,
              err,
            );
          }
        }

        console.log(`[ServerSync] Scanned workspace: ${files.length} files`);
        return files;
      } catch (err) {
        console.error("[ServerSync] Failed to scan workspace:", err);
        throw err;
      }
    }

    /**
     * Commit workspace to server
     */
    async function commitWorkspace(message?: string) {
      // Note: We don't check authentication upfront because:
      // 1. Anonymous playground creation is allowed
      // 2. The server will return 401 if auth is required for existing playgrounds
      // 3. We'll handle auth prompts when the server returns 401

      // Show progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing workspace to server...",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Scanning files..." });

          // Scan all files
          const files = await scanWorkspace();

          if (files.length === 0) {
            vscode.window.showWarningMessage("No files to sync");
            return;
          }

          progress.report({ message: `Uploading ${files.length} files...` });

          // Get the currently active editor file path
          const activeEditor = vscode.window.activeTextEditor;
          const activeFile = activeEditor?.document.uri.path || null;

          // Prepare commit message
          const commitMessage =
            message ||
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
          const response = await api("/api/me", {
            credentials: "include",
          });
          if (response.error) {
            console.warn("[ServerSync] Failed to check auth status:", response.error);
          } else {
            const me = response.data && !("error" in response.data) ? response.data : null;
            isAuthenticated = !!me?.user?.id;
            console.log("[ServerSync] Auth check:", {
              isAuthenticated,
              userId: me?.user?.id,
              username: me?.user?.username,
            });
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

            if (encoded.length <= 16384) {
              // Navigate to shared URL
              router.updateCurrentRoute({
                type: "shared",
                params: { data: encoded },
                path: `/s/${encoded}`,
              });
              replaceTo("shared", { data: encoded });

              // Update baseline
              baselineFiles.clear();
              files.forEach((f) => baselineFiles.set(f.path, f.content));
              changedFiles.clear();
              updateSCMView();
              await refreshQuickDiff();

              scm.inputBox.value = "";

              vscode.window.showInformationMessage(
                `Shareable link created! Share the URL to let others load this workspace.`,
              );
              return;
            }
            // Payload too large for URL — fall through to server-side save
          }

          const { data: result, error } = await (currentPlaygroundHash &&
            isAuthenticated
            ? api("/api/playgrounds/:hash/commits", {
              method: "POST",
              params: { hash: currentPlaygroundHash },
              body: {
                message: commitMessage,
                files,
                activeFile,
              },
            })
            : api("/api/playgrounds", {
              method: "POST",
              body: {
                name: playgroundName,
                message: commitMessage,
                description: "New playground",
                files,
                activeFile,
              },
            }));

          if (error) {
            console.error("[ServerSync] Commit failed:", error);

            // If 401 Unauthorized, prompt to sign in
            if (error.status === 401) {
              const choice = await vscode.window.showWarningMessage(
                "Your session has expired. Please sign in again to sync.",
                "Sign In",
                "Cancel",
              );

              if (choice === "Sign In") {
                try {
                  await vscode.authentication.getSession("github-auth", [], {
                    createIfNone: true,
                    forceNewSession: true,
                  });
                  vscode.window.showInformationMessage(
                    "Signed in successfully. Please try syncing again.",
                  );
                } catch {
                  vscode.window.showErrorMessage(
                    "Authentication failed. Please try again.",
                  );
                }
              }
              return;
            }

            throw new Error(
              `Failed to commit workspace: ${error.status} ${error.value}`,
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
          const playgroundHashChanged =
            currentPlaygroundHash !== commitResult.playground_hash;
          const wasForked = commitResult.forked === true;

          // Update current commit and playground tracking
          currentCommitId = commitResult.commit_id;
          currentPlaygroundHash = commitResult.playground_hash;

          // Navigate to the playground URL if hash changed
          // This happens for:
          // - First sync (no previous hash)
          // - Anonymous user syncing (always creates new playground)
          // - Authenticated user forking (anonymous or other user's playground)
          if (playgroundHashChanged && commitResult.playground_hash) {
            console.log(
              "[ServerSync] Playground hash changed - updating URL to:",
              commitResult.playground_hash,
              wasForked
                ? "(forked)"
                : isAuthenticated
                  ? "(first sync)"
                  : "(anonymous snapshot)",
            );

            // Update router state to reflect the new playground
            // This prevents the router from intercepting and reloading the workspace
            router.updateCurrentRoute({
              type: "playground",
              params: { playgroundId: commitResult.playground_hash },
              path: `/playgrounds/${commitResult.playground_hash}`,
            });

            // Now update the URL using history replace
            // Router will see routes as equal and won't intercept
            replaceTo("playground", {
              playgroundId: commitResult.playground_hash,
            });
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
            vscode.window.showInformationMessage(
              `Playground forked: ${files.length} file(s) saved. You now own this copy and can continue making commits.`,
            );
          } else if (!isAuthenticated && playgroundHashChanged) {
            // Anonymous user created a new snapshot
            const action = await vscode.window.showInformationMessage(
              `Anonymous snapshot created: ${files.length} file(s) saved. Each sync creates a new shareable link.`,
              "Sign In for Continuous Sync",
            );

            if (action === "Sign In for Continuous Sync") {
              try {
                await vscode.authentication.getSession("github-auth", [], {
                  createIfNone: true,
                });
                vscode.window.showInformationMessage(
                  "Signed in! Future syncs will update this playground.",
                );
              } catch {
                // User cancelled, ignore
              }
            }
          } else {
            // Authenticated user committing to their own playground
            vscode.window.showInformationMessage(
              `Workspace synced: ${files.length} file(s) saved`,
            );
          }

          // Refresh commit history and status bar
          commitHistoryProvider.refresh();
          forkHistoryProvider.refresh();
          void updateStatusBar();
        }
      );
    }

    /**
     * Update SCM view with changed files
     */
    function updateSCMView() {
      const resourceStates: SourceControlResourceState[] = Array.from(
        changedFiles.values(),
      ).map((uri) => ({
        resourceUri: uri,
        command: {
          title: "Open",
          command: VSCODE_OPEN,
          arguments: [uri],
        },
      }));

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
        const content = await vscode.workspace.fs.readFile(uri);
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
      private _onDidChangeTreeData: vscode.EventEmitter<
        CommitHistoryItem | undefined | void
      > = new vscode.EventEmitter<CommitHistoryItem | undefined | void>();
      readonly onDidChangeTreeData: vscode.Event<
        CommitHistoryItem | undefined | void
      > = this._onDidChangeTreeData.event;

      refresh(): void {
        this._onDidChangeTreeData.fire();
      }

      getTreeItem(element: CommitHistoryItem): TreeItem {
        const isCurrentCommit = element.id === currentCommitId;
        const label = element.message || `Commit ${element.id.substring(0, 8)}`;
        const treeItem = new vscode.TreeItem(
          isCurrentCommit ? `✓ ${label}` : label,
        );
        treeItem.id = element.id;
        treeItem.description = new Date(element.timestamp).toLocaleString();
        treeItem.tooltip = `${element.fileCount} file(s) • ${element.username || "Unknown user"} • ${element.id}${isCurrentCommit ? " (currently loaded)" : ""}`;
        treeItem.contextValue = "commit";
        treeItem.iconPath = new vscode.ThemeIcon(
          isCurrentCommit ? "circle-filled" : "git-commit",
        );
        treeItem.command = {
          command: SERVER_SYNC_VIEW_COMMIT,
          title: "View Commit",
          arguments: [element.id],
        };
        return treeItem;
      }

      async getChildren(
        element?: CommitHistoryItem,
      ): Promise<CommitHistoryItem[]> {
        if (element) {
          // No children for commits
          return [];
        }

        // If no playground is loaded, show empty list
        if (!currentPlaygroundHash) {
          console.log(
            "[ServerSync] No playground loaded, commit history is empty",
          );
          return [];
        }

        try {
          // Fetch commits from server - GET /playgrounds/:hash/commits
          const { data: commits, error } = await api(
            "/api/playgrounds/:hash/commits",
            {
              method: "GET",
              params: { hash: currentPlaygroundHash },
            },
          );

          if (error) {
            console.error(
              "[ServerSync] Failed to load commits:",
              error.status,
              error.value,
            );
            return [];
          }

          if (!commits || !Array.isArray(commits)) return [];

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
    vscode.window.createTreeView(SERVER_SYNC_COMMIT_HISTORY, {
      treeDataProvider: commitHistoryProvider,
      showCollapseAll: false,
    });

    /**
     * Fork History Tree Data Provider
     * Shows the fork chain for the current playground
     */
    class ForkHistoryProvider implements TreeDataProvider<ForkHistoryItem> {
      private _onDidChangeTreeData: vscode.EventEmitter<
        ForkHistoryItem | undefined | void
      > = new vscode.EventEmitter<ForkHistoryItem | undefined | void>();
      readonly onDidChangeTreeData: vscode.Event<
        ForkHistoryItem | undefined | void
      > = this._onDidChangeTreeData.event;

      private forkChain: ForkHistoryItem[] = [];

      refresh(): void {
        this._onDidChangeTreeData.fire();
      }

      getTreeItem(element: ForkHistoryItem): TreeItem {
        const label = element.name || element.hash.substring(0, 8);
        const treeItem = new vscode.TreeItem(
          element.isCurrent ? `✓ ${label}` : label,
        );
        treeItem.id = element.hash;
        treeItem.description = element.owner
          ? `by ${element.owner}`
          : "anonymous";
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

      async getChildren(
        element?: ForkHistoryItem,
      ): Promise<ForkHistoryItem[]> {
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
            api("/api/playgrounds/:hash", { method: "GET", params: { hash } });

          // Build fork chain by traversing fork_of references
          const chain: ForkHistoryItem[] = [];
          let currentHash: string | null = currentPlaygroundHash;

          while (currentHash) {
            const { data: playground, error } = await fetchPlayground(currentHash);

            if (error || !playground || "error" in playground) break;

            chain.push({
              hash: playground.hash,
              name: playground.name ?? "Untitled",
              owner: playground.user?.username ?? undefined,
              isCurrent: playground.hash === currentPlaygroundHash,
            });

            // Get the fork source (field may exist but isn't in the API's static type)
            const forkOf: { hash: string } | null | undefined =
              (playground as unknown as { fork_of?: { hash: string } | null }).fork_of;
            currentHash = forkOf?.hash ?? null;
          }

          // Show from oldest to newest (fork source first)
          this.forkChain = chain.reverse();

          console.log(
            `[ServerSync] Fork history: ${this.forkChain.length} items`,
          );

          return this.forkChain;
        } catch (err) {
          console.error("[ServerSync] Error loading fork history:", err);
          return [];
        }
      }
    }

    const forkHistoryProvider = new ForkHistoryProvider();

    // Register tree view for fork history in SCM view container
    vscode.window.createTreeView(SERVER_SYNC_FORK_HISTORY, {
      treeDataProvider: forkHistoryProvider,
      showCollapseAll: false,
    });

    // Register commands
    vscode.commands.registerCommand(SERVER_SYNC_COMMIT, commitWorkspace);

    vscode.commands.registerCommand(SERVER_SYNC_REFRESH, () => {
      // Reload the page to restore from latest commit
      void vscode.window
        .showInformationMessage("Reloading workspace from server...", "Reload")
        .then((selection) => {
          if (selection === "Reload") {
            window.location.reload();
          }
        });
    });

    vscode.commands.registerCommand(SERVER_SYNC_REFRESH_HISTORY, () => {
      commitHistoryProvider.refresh();
    });

    vscode.commands.registerCommand(SERVER_SYNC_REFRESH_FORK_HISTORY, () => {
      forkHistoryProvider.refresh();
    });

    vscode.commands.registerCommand(
      SERVER_SYNC_VIEW_FORK_SOURCE,
      (hash: string) => {
        // Navigate to the fork source playground
        const url = `/playgrounds/${hash}`;
        console.log("[ServerSync] Opening fork source:", url);

        if (window.navigation) {
          window.navigation.navigate(url);
        } else {
          window.location.href = url;
        }
      },
    );

    vscode.commands.registerCommand(
      SERVER_SYNC_VIEW_COMMIT,
      async (commitId: string) => {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Loading commit diff...",
              cancellable: false,
            },
            async () => {
              // Need to know which playground this commit belongs to
              if (!currentPlaygroundHash) {
                vscode.window.showErrorMessage("No playground loaded");
                return;
              }

              // Fetch diff from server - GET /playgrounds/:hash/commits/:commit_id/diff
              const { data: result, error } = await api(
                "/api/playgrounds/:hash/commits/:commit_id/diff",
                {
                  method: "GET",
                  params: { hash: currentPlaygroundHash, commit_id: commitId },
                },
              );

              if (error) {
                vscode.window.showErrorMessage(
                  `Failed to load commit diff: ${error.status} ${JSON.stringify(error.value)}`,
                );
                return;
              }

              if (!result) {
                vscode.window.showErrorMessage(
                  "Failed to load commit diff: no data",
                );
                return;
              }

              // Result is the diff object directly
              const diff = result;

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
                vscode.window.showInformationMessage(
                  "No changes in this commit",
                );
                return;
              }

              const selected = await vscode.window.showQuickPick(items, {
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
                await vscode.commands.executeCommand(VSCODE_OPEN, uri);
              } else if (selected.type === "deleted") {
                // Show deleted file content (read-only)
                vscode.window.showInformationMessage(
                  `File was deleted: ${selected.file.path}`,
                );
              } else {
                // Show diff for modified files
                const leftUri = vscode.Uri.parse(
                  `${scheme}:${selected.file.path}?old`,
                );
                const rightUri = vscode.Uri.file(selected.file.path);

                // Register content provider for old version
                const disposable =
                  vscode.workspace.registerTextDocumentContentProvider(scheme, {
                    provideTextDocumentContent(uri: vscode.Uri): string {
                      if (uri.query === "old") {
                        return selected.file.oldContent || "";
                      }
                      return "";
                    },
                  });

                try {
                  await vscode.commands.executeCommand(
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
          );
        } catch (err) {
          console.error("[ServerSync] Error viewing commit diff:", err);
          vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    vscode.commands.registerCommand(
      SERVER_SYNC_LOAD_COMMIT,
      (item: CommitHistoryItem | string) => {
        // Handle being called from context menu (CommitHistoryItem) or directly (string)
        const commitId = typeof item === "string" ? item : item.id;

        // Navigate to the commit URL - this will trigger the router
        // which will load the workspace via workspaceSwitcher
        // The playgroundId is the same as commitId for now (since playground = commit in current schema)
        const playgroundId = commitId;
        const url = `/playgrounds/${playgroundId}/commits/${commitId}`;

        console.log("[ServerSync] Navigating to commit URL:", url);

        if (window.navigation) {
          window.navigation.navigate(url);
        } else {
          // Fallback: reload with URL (shouldn't happen with polyfill)
          window.location.href = url;
        }
      },
    );

    vscode.commands.registerCommand(
      SERVER_SYNC_RESTORE_COMMIT,
      async (item: CommitHistoryItem | string) => {
        // Handle being called from context menu (CommitHistoryItem) or directly (string)
        const commitId = typeof item === "string" ? item : item.id;

        const confirm = await vscode.window.showWarningMessage(
          "This will restore all files from this commit. Current changes will be overwritten. Continue?",
          "Restore",
          "Cancel",
        );

        if (confirm !== "Restore") {
          return;
        }

        try {
          // Need to know which playground this commit belongs to
          if (!currentPlaygroundHash) {
            vscode.window.showErrorMessage("No playground loaded");
            return;
          }

          // Fetch commit - GET /playgrounds/:hash/commits/:commit_id
          const { data: commit, error } = await api(
            "/api/playgrounds/:hash/commits/:commit_id",
            {
              method: "GET",
              params: { hash: currentPlaygroundHash, commit_id: commitId },
            },
          );

          if (error) {
            vscode.window.showErrorMessage(
              `Failed to load commit: ${error.status} ${JSON.stringify(error.value)}`,
            );
            return;
          }

          if (!commit) {
            vscode.window.showErrorMessage("Commit not found");
            return;
          }

          // Delete all existing files first
          const allFiles = await vscode.workspace.findFiles(
            "**/*",
            "**/node_modules/**",
          );
          for (const file of allFiles) {
            try {
              await vscode.workspace.fs.delete(file);
            } catch (err) {
              console.warn(`Failed to delete ${file.path}:`, err);
            }
          }

          // Restore files from commit
          for (const file of commit.files) {
            try {
              const uri = vscode.Uri.file(file.path);
              const content = new TextEncoder().encode(file.content);

              // Create parent directories if needed
              const dirUri = vscode.Uri.file(
                file.path.substring(0, file.path.lastIndexOf("/")),
              );
              try {
                await vscode.workspace.fs.createDirectory(dirUri);
              } catch {
                // Directory might already exist, ignore
              }

              await vscode.workspace.fs.writeFile(uri, content);
            } catch (err) {
              console.warn(`Failed to restore file ${file.path}:`, err);
            }
          }

          vscode.window.showInformationMessage(
            `Restored ${commit.files.length} files from commit`,
          );

          // Update current commit tracking
          currentCommitId = commitId;

          // Update baseline to restored commit
          baselineFiles.clear();
          commit.files.forEach((f) => baselineFiles.set(f.path, f.content));

          // Clear changed files (restored commit is the new baseline)
          changedFiles.clear();
          updateSCMView();

          // Refresh quick diff decorations to show comparison with restored commit
          await refreshQuickDiff();

          // Refresh tree to show the active commit
          commitHistoryProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    /**
     * Command: server-sync.workspaceLoaded
     * Called by workspaceSwitcher when a workspace is loaded
     * Updates the SCM baseline and current commit tracking
     */
    vscode.commands.registerCommand(
      SERVER_SYNC_WORKSPACE_LOADED,
      async (data: {
        commitId: string;
        playgroundHash: string;
        files: Array<{ path: string; content: string }>;
      }) => {
        console.log(
          "[ServerSync] Workspace loaded notification:",
          data.commitId,
          data.playgroundHash,
          `${data.files.length} files`,
        );

        // Update current commit and playground tracking
        currentCommitId = data.commitId;
        currentPlaygroundHash = data.playgroundHash;

        // Update baseline to loaded workspace
        baselineFiles.clear();
        data.files.forEach((f) => baselineFiles.set(f.path, f.content));

        // Clear changed files (loaded workspace is the new baseline)
        changedFiles.clear();
        updateSCMView();

        // Refresh quick diff decorations to show comparison with loaded workspace
        await refreshQuickDiff();

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
        await updateStatusBar();
      },
    );

    // Register baseline content provider for quick diff
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      baselineContentProvider,
    );

    // Create SCM provider
    const scm = vscode.scm.createSourceControl(
      "server-sync",
      "Server Sync",
      workspaceFolder.uri,
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
        const { data: commits, error } = await api(
          "/api/playgrounds/:hash/commits",
          {
            method: "GET",
            params: { hash: currentPlaygroundHash },
          },
        );

        if (error || !commits) {
          scm.statusBarCommands = undefined;
          return;
        }

        totalCommits = commits.length;
        currentCommitIndex = commits.findIndex(
          (c) => c.id === currentCommitId,
        );

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
    vscode.commands.registerCommand(SERVER_SYNC_CHECKOUT_VERSION, async () => {
      if (!currentPlaygroundHash) {
        vscode.window.showErrorMessage("No playground loaded");
        return;
      }

      try {
        const { data: commits, error } = await api(
          "/api/playgrounds/:hash/commits",
          {
            method: "GET",
            params: { hash: currentPlaygroundHash },
          },
        );

        if (error || !commits) {
          vscode.window.showErrorMessage("Failed to load commits");
          return;
        }

        interface VersionQuickPickItem extends vscode.QuickPickItem {
          commitId: string;
        }

        const items: VersionQuickPickItem[] = commits.map((commit, index) => ({
          label: `${commit.id === currentCommitId ? "✓ " : ""}Version ${index + 1}`,
          description: commit.message || `Commit ${commit.id.substring(0, 8)}`,
          detail: `${commit.username || "Unknown"} • ${new Date(commit.timestamp).toLocaleString()}`,
          commitId: commit.id,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Select a version to checkout (currently at ${currentCommitIndex + 1}/${totalCommits})`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected && selected.commitId !== currentCommitId) {
          // Navigate to the selected commit
          const url = `/playgrounds/${currentPlaygroundHash}/commits/${selected.commitId}`;
          if (window.navigation) {
            window.navigation.navigate(url);
          } else {
            window.location.href = url;
          }
        }
      } catch (err) {
        console.error("[ServerSync] Error in checkout version:", err);
        vscode.window.showErrorMessage("Failed to load versions");
      }
    });

    // Create resource group for changed files
    const workingTreeGroup = scm.createResourceGroup("working-tree", "Changes");

    // Watch for file changes
    vscode.workspace.onDidChangeTextDocument((event) => {
      void markFileAsChanged(event.document.uri);
    });

    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        void markFileAsChanged(uri);
      }
    });

    vscode.workspace.onDidDeleteFiles((event) => {
      event.files.forEach((uri) => {
        // For deleted files, check if they existed in baseline
        if (baselineFiles.has(uri.path)) {
          changedFiles.set(uri.toString(), uri);
          updateSCMView();
          console.log(`[ServerSync] File deleted: ${uri.path}`);
        }
      });
    });

    vscode.workspace.onDidRenameFiles((event) => {
      event.files.forEach((file) => {
        void markFileAsChanged(file.oldUri);
        void markFileAsChanged(file.newUri);
      });
    });

    // Initialize baseline from workspace (start with clean state)
    // On first load, we'll compare against current state (so initially nothing is "changed")
    const allFiles = await vscode.workspace.findFiles(
      "**/*",
      "**/node_modules/**",
    );
    for (const fileUri of allFiles) {
      try {
        const content = await vscode.workspace.fs.readFile(fileUri);
        const textContent = new TextDecoder().decode(content);
        baselineFiles.set(fileUri.path, textContent);
      } catch (err) {
        console.warn(
          `[ServerSync] Failed to read initial file ${fileUri.path}:`,
          err,
        );
      }
    }

    // Start with empty changed files (like Git after clone/init)
    updateSCMView();

    console.log("[ServerSync] Initialized successfully");
  })
  .catch((err) => {
    console.error("[ServerSync] Failed to initialize:", err);
  });
