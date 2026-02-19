/**
 * Workspace Switcher
 * Centralized logic for loading playgrounds/commits into the workspace
 */

import * as vscode from "vscode";
import { IWorkingCopyService, getService } from "@codingame/monaco-vscode-api";
import * as S from "effect/Schema";
import { api } from "../api-client";
import { getSmallExampleWorkspace } from "../templates";
import {
  PLAYGROUND_SHOW_BROWSER,
  SERVER_SYNC_WORKSPACE_LOADED,
  VSCODE_OPEN,
  WORKBENCH_ACTION_CLOSE_ALL_EDITORS,
} from "./constants";

/** Schema for base64-encoded shared workspace payloads */
const SharedWorkspacePayload = S.Struct({
  files: S.Array(S.Struct({ path: S.String, content: S.String })),
  activeFile: S.NullishOr(S.String),
});
// Note: Storage is now fully ephemeral (see ephemeralStorageProvider in setup.common.ts).
// VS Code no longer restores session state from IndexedDB between page loads.

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface LoadWorkspaceOptions {
  playgroundHash: string;
  commitId?: string;
  updateUrl?: boolean; // Should we update the URL? (false for initial load)
}

export interface WorkspaceData {
  id: string;
  name: string;
  message: string;
  timestamp: number;
  files: WorkspaceFile[];
  activeFile?: string | null;
}

/**
 * Clear all files from the workspace and show the playground browser
 * Used when a playground/commit is not found to prevent loading stale data
 */
async function clearWorkspace(): Promise<void> {
  console.log("[WorkspaceSwitcher] Clearing workspace...");

  // Close all open editors
  await vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS);

  // Delete all existing files from the overlay filesystem
  const allFiles = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
  for (const file of allFiles) {
    try {
      await vscode.workspace.fs.delete(file);
    } catch (err) {
      console.warn(`[WorkspaceSwitcher] Failed to delete ${file.path}:`, err);
    }
  }

  // Also clear the IndexedDB filesystem layer to prevent files from persisting across sessions
  // NOTE: We do NOT reset userDataProvider here because it would also clear the PGlite database
  // which causes "Can't start a transaction on a closed database" errors.
  // The workspace files are already deleted above via vscode.workspace.fs.delete()
  // so the IndexedDB will be cleaned up naturally.
  //
  // try {
  //   await userDataProvider.reset();
  //   console.log("[WorkspaceSwitcher] IndexedDB workspace cleared");
  // } catch (err) {
  //   console.warn("[WorkspaceSwitcher] Failed to reset IndexedDB provider:", err);
  // }

  // Recreate the /workspace directory to satisfy VSCode workspace folder requirement
  try {
    const workspaceDir = vscode.Uri.file("/workspace");
    await vscode.workspace.fs.createDirectory(workspaceDir);
    console.log("[WorkspaceSwitcher] Recreated /workspace directory");
  } catch (err) {
    console.warn("[WorkspaceSwitcher] Failed to recreate /workspace directory:", err);
  }

  console.log("[WorkspaceSwitcher] Workspace cleared");

  // Open the playground browser to help the user find/create a playground
  try {
    await vscode.commands.executeCommand(PLAYGROUND_SHOW_BROWSER);
  } catch (err) {
    console.warn("[WorkspaceSwitcher] Failed to open playground browser:", err);
  }
}

/**
 * Check if user has existing work (files in workspace or dirty editors)
 * Used to determine whether to load sample project or preserve existing state
 */
async function hasExistingWork(): Promise<boolean> {
  // Check for dirty working copies (unsaved editor changes)
  try {
    const workingCopyService = await getService(IWorkingCopyService);
    if (workingCopyService.hasDirty) {
      console.log("[WorkspaceSwitcher] Found dirty working copies");
      return true;
    }
  } catch (err) {
    console.warn("[WorkspaceSwitcher] Could not access IWorkingCopyService:", err);
  }

  // Check for existing files in workspace (persisted from IndexedDB)
  const existingFiles = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
  if (existingFiles.length > 0) {
    console.log(`[WorkspaceSwitcher] Found ${existingFiles.length} existing files`);
    return true;
  }

  return false;
}

/**
 * Load the sample workspace for first-time visitors
 * Creates example files and opens them in the editor
 */
async function loadSampleWorkspace(): Promise<void> {
  console.log("[WorkspaceSwitcher] Loading sample workspace...");

  let template: import("../templates").WorkspaceTemplate;
  if (import.meta.env.DEV) {
    const { default: getBigSchema } = await import("../example-big-schema");
    template = getBigSchema();
  } else {
    template = getSmallExampleWorkspace();
  }

  // Write sample files to workspace
  for (const [path, content] of Object.entries(template.files)) {
    const uri = vscode.Uri.file(path);

    // Create parent directories if needed
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      const dirUri = vscode.Uri.file(path.substring(0, lastSlash));
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // Directory might already exist, ignore
      }
    }

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  // Open default editor(s) from template
  for (const editor of template.defaultLayout.editors) {
    const uri = vscode.Uri.file(editor.uri);
    await vscode.commands.executeCommand(VSCODE_OPEN, uri);
  }

  console.log("[WorkspaceSwitcher] Sample workspace loaded");
}

/**
 * Load a workspace (playground or specific commit) into the editor
 * This is the central function for all workspace loading operations
 */
export async function loadWorkspace(options: LoadWorkspaceOptions): Promise<void> {
  const { playgroundHash, commitId, updateUrl = false } = options;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: commitId ? "Loading commit..." : "Loading playground...",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Fetching data..." });

        let result: {
          id: string;
          message: string;
          created_at: string | Date;
          playground_hash: string;
          parent_id: string | null;
          files: Array<{ path: string; content: string }>;
          activeFile: string | null;
          timestamp: number;
        };

        if (commitId) {
          // Loading a specific commit - GET /playgrounds/:hash/commits/:commit_id
          const { data, error } = await api("/api/playgrounds/:hash/commits/:commit_id", {
            params: {
              hash: playgroundHash,
              commit_id: commitId,
            },
          });

          if (error) {
            // Handle 404 - commit/playground not found
            if (error.status === 404) {
              await clearWorkspace();
              vscode.window.showWarningMessage(`Commit not found: ${commitId.substring(0, 8)}`);
              return; // Exit early - don't load any data from memory
            }
            throw new Error(
              `Failed to fetch workspace: ${error.status} ${JSON.stringify(error.value)}`,
            );
          }

          if (!data) {
            throw new Error("Invalid workspace data received");
          }

          result = data;
        } else {
          // Loading a playground's latest commit
          // First, get all commits for this playground - GET /playgrounds/:hash/commits
          const { data: commits, error: commitsError } = await api(
            "/api/playgrounds/:hash/commits",
            {
              params: {
                hash: playgroundHash,
              },
            },
          );

          if (commitsError) {
            // Handle 404 - playground not found
            if ((commitsError.status as number) === 404) {
              await clearWorkspace();
              vscode.window.showWarningMessage(`Playground not found: ${playgroundHash}`);
              return; // Exit early - don't load any data from memory
            }
            // Handle 401 - not authorized to view playground
            if ((commitsError.status as number) === 401) {
              await clearWorkspace();
              vscode.window.showWarningMessage(`You don't have permission to view this playground`);
              return; // Exit early - don't load any data from memory
            }
            throw new Error(
              `Failed to fetch playground commits: ${commitsError.status} ${JSON.stringify(commitsError.value)}`,
            );
          }

          if (!commits || !Array.isArray(commits) || commits.length === 0) {
            // Playground exists but has no commits - clear the workspace and show message
            progress.report({ message: "Clearing workspace..." });
            await clearWorkspace();

            vscode.window.showInformationMessage(
              `Playground #${playgroundHash} is empty. Create some files and click "Sync to Server" to save your first commit.`,
            );
            return; // Exit early - workspace is now clean and empty
          }

          // Get the latest commit (first one, since they're ordered by created_at desc)
          const latestCommitId = commits[0]!.id;

          // Now fetch that commit's data - GET /playgrounds/:hash/commits/:commit_id
          const { data, error: commitError } = await api(
            "/api/playgrounds/:hash/commits/:commit_id",
            {
              params: {
                hash: playgroundHash,
                commit_id: latestCommitId,
              },
            },
          );

          if (commitError) {
            throw new Error(
              `Failed to fetch workspace: ${commitError.status} ${JSON.stringify(commitError.value)}`,
            );
          }

          if (!data) {
            throw new Error("Invalid workspace data received");
          }

          result = data;
        }

        const data = result;
        const workspace: WorkspaceData = {
          id: data.id,
          name: data.message || `Playground ${playgroundHash}`,
          message: data.message || "",
          timestamp: data.timestamp,
          files: data.files || [],
          activeFile: data.activeFile || null,
        };

        console.log("[WorkspaceSwitcher] Loading workspace:", workspace.id, workspace.name);
        console.log("[WorkspaceSwitcher] Files:", workspace.files.length);

        progress.report({
          message: `Loading ${workspace.files.length} files...`,
        });

        // Close all open editors first
        await vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS);

        // Delete all existing files
        const allFiles = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
        for (const file of allFiles) {
          try {
            await vscode.workspace.fs.delete(file);
          } catch (err) {
            console.warn(`[WorkspaceSwitcher] Failed to delete ${file.path}:`, err);
          }
        }

        // Load files from workspace
        for (const file of workspace.files) {
          try {
            const uri = vscode.Uri.file(file.path);
            const content = new TextEncoder().encode(file.content);

            // Create parent directories if needed
            const lastSlash = file.path.lastIndexOf("/");
            if (lastSlash > 0) {
              const dirUri = vscode.Uri.file(file.path.substring(0, lastSlash));
              try {
                await vscode.workspace.fs.createDirectory(dirUri);
              } catch {
                // Directory might already exist, ignore
              }
            }

            await vscode.workspace.fs.writeFile(uri, content);
          } catch (err) {
            console.warn(`[WorkspaceSwitcher] Failed to load file ${file.path}:`, err);
          }
        }

        // Open the active file if specified
        if (workspace.activeFile) {
          try {
            const activeUri = vscode.Uri.file(workspace.activeFile);
            await vscode.commands.executeCommand(VSCODE_OPEN, activeUri);
            console.log(`[WorkspaceSwitcher] Opened active file: ${workspace.activeFile}`);
          } catch (err) {
            console.warn(
              `[WorkspaceSwitcher] Failed to open active file ${workspace.activeFile}:`,
              err,
            );
          }
        } else if (workspace.files.length > 0) {
          // No active file specified, open the first file as fallback
          try {
            const firstFile = workspace.files[0]!;
            const firstUri = vscode.Uri.file(firstFile.path);
            await vscode.commands.executeCommand(VSCODE_OPEN, firstUri);
            console.log(`[WorkspaceSwitcher] Opened first file: ${firstFile.path}`);
          } catch (err) {
            console.warn(`[WorkspaceSwitcher] Failed to open first file:`, err);
          }
        }

        // Update URL if requested (client-side navigation)
        if (updateUrl) {
          const path = commitId
            ? `/playgrounds/${playgroundHash}/commits/${commitId}`
            : `/playgrounds/${playgroundHash}`;

          if (window.navigation) {
            window.navigation.navigate(path);
          }
        }

        // Notify serverSync extension about the loaded workspace
        // This updates the SCM baseline and current commit tracking
        vscode.commands.executeCommand(SERVER_SYNC_WORKSPACE_LOADED, {
          commitId: workspace.id,
          playgroundHash: playgroundHash,
          files: workspace.files,
        });

        vscode.window.showInformationMessage(
          `Loaded ${workspace.name}: ${workspace.files.length} file(s)`,
        );
      },
    );
  } catch (err) {
    console.error("[WorkspaceSwitcher] Error loading workspace:", err);
    vscode.window.showErrorMessage(
      `Failed to load workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Load workspace from a base64-encoded shared URL
 * Decodes the data parameter and writes files to the workspace
 */
export async function loadWorkspaceFromSharedUrl(data: string): Promise<void> {
  try {
    // Reverse base64url: restore +, /, and = padding
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(base64)));
    const payload = S.decodeUnknownSync(SharedWorkspacePayload)(JSON.parse(json));

    console.log(`[WorkspaceSwitcher] Loading shared workspace: ${payload.files.length} files`);

    // Close all open editors
    await vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS);

    // Delete all existing files
    const allFiles = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
    for (const file of allFiles) {
      try {
        await vscode.workspace.fs.delete(file);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to delete ${file.path}:`, err);
      }
    }

    // Write files from shared data
    for (const file of payload.files) {
      try {
        const uri = vscode.Uri.file(file.path);
        const content = new TextEncoder().encode(file.content);

        const lastSlash = file.path.lastIndexOf("/");
        if (lastSlash > 0) {
          const dirUri = vscode.Uri.file(file.path.substring(0, lastSlash));
          try {
            await vscode.workspace.fs.createDirectory(dirUri);
          } catch {
            // Directory might already exist
          }
        }

        await vscode.workspace.fs.writeFile(uri, content);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to load file ${file.path}:`, err);
      }
    }

    // Open the active file if specified
    if (payload.activeFile) {
      try {
        const activeUri = vscode.Uri.file(payload.activeFile);
        await vscode.commands.executeCommand(VSCODE_OPEN, activeUri);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to open active file:`, err);
      }
    } else {
      const firstFile = payload.files[0];
      if (firstFile) {
        try {
          const firstUri = vscode.Uri.file(firstFile.path);
          await vscode.commands.executeCommand(VSCODE_OPEN, firstUri);
        } catch (err) {
          console.warn(`[WorkspaceSwitcher] Failed to open first file:`, err);
        }
      }
    }

    vscode.window.showInformationMessage(
      `Loaded shared workspace: ${payload.files.length} file(s)`,
    );
  } catch (err) {
    console.error("[WorkspaceSwitcher] Failed to load shared workspace:", err);
    vscode.window.showErrorMessage(
      `Failed to load shared workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Load workspace from initial data injected by server
 * Used during page load
 */
export async function loadWorkspaceFromInitialData(): Promise<void> {
  const initialData = window.__INITIAL_DATA__;

  if (!initialData) {
    console.log("[WorkspaceSwitcher] No initial data available");
    // Check if user has existing work before deciding what to do
    if (await hasExistingWork()) {
      console.log("[WorkspaceSwitcher] Preserving existing workspace");
    } else {
      console.log("[WorkspaceSwitcher] Empty workspace, loading sample...");
      await loadSampleWorkspace();
    }
    return;
  }

  // Use the new route-aware data structure
  const { route, commit } = initialData;

  // Shared routes: data is in the URL, handled by the router
  if (route?.type === "shared") {
    console.log("[WorkspaceSwitcher] Shared route — router will handle loading");
    return;
  }

  if (!commit || !route) {
    console.log("[WorkspaceSwitcher] No workspace data to load");
    // Check if user has existing work before deciding what to do
    if (await hasExistingWork()) {
      console.log("[WorkspaceSwitcher] Preserving existing workspace");
    } else {
      console.log("[WorkspaceSwitcher] Empty workspace, loading sample...");
      await loadSampleWorkspace();
    }
    return;
  }

  console.log(
    "[WorkspaceSwitcher] Loading from initial data:",
    route.type,
    route.playgroundHash,
    route.commitId,
  );

  try {
    // Close all open editors and clear existing files before restoring
    // (IndexedDB may have stale files from a previous session)
    await vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS);
    const allFiles = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
    for (const file of allFiles) {
      try {
        await vscode.workspace.fs.delete(file);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to delete ${file.path}:`, err);
      }
    }

    let restoredCount = 0;
    let errorCount = 0;

    // Restore each file
    for (const file of commit.files) {
      try {
        const uri = vscode.Uri.file(file.path);
        const content = new TextEncoder().encode(file.content);

        // Create parent directories if needed
        const lastSlash = file.path.lastIndexOf("/");
        if (lastSlash > 0) {
          const dirUri = vscode.Uri.file(file.path.substring(0, lastSlash));
          try {
            await vscode.workspace.fs.createDirectory(dirUri);
          } catch {
            // Directory might already exist, ignore
          }
        }

        // Write file
        await vscode.workspace.fs.writeFile(uri, content);
        restoredCount++;
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to restore file ${file.path}:`, err);
        errorCount++;
      }
    }

    console.log(
      `[WorkspaceSwitcher] Restoration complete: ${restoredCount} files restored, ${errorCount} errors`,
    );

    // Open the active file if specified
    const activeFile = commit.activeFile;
    if (activeFile) {
      try {
        const activeUri = vscode.Uri.file(activeFile);
        await vscode.commands.executeCommand(VSCODE_OPEN, activeUri);
        console.log(`[WorkspaceSwitcher] Opened active file: ${activeFile}`);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to open active file ${activeFile}:`, err);
      }
    } else if (commit.files.length > 0) {
      // No active file specified, open the first file as fallback
      try {
        const firstFile = commit.files[0]!;
        const firstUri = vscode.Uri.file(firstFile.path);
        await vscode.commands.executeCommand(VSCODE_OPEN, firstUri);
        console.log(`[WorkspaceSwitcher] Opened first file: ${firstFile.path}`);
      } catch (err) {
        console.warn(`[WorkspaceSwitcher] Failed to open first file:`, err);
      }
    }

    // Notify serverSync about the loaded workspace
    vscode.commands.executeCommand(SERVER_SYNC_WORKSPACE_LOADED, {
      commitId: commit.id,
      playgroundHash: route.playgroundHash || commit.id,
      files: commit.files,
    });

    if (restoredCount > 0) {
      // Show a subtle notification
      vscode.window.showInformationMessage(
        `Workspace restored: ${restoredCount} file(s) from ${new Date(commit.timestamp).toLocaleString()}`,
      );
    }
  } catch (err) {
    console.error("[WorkspaceSwitcher] Failed to restore workspace:", err);
    vscode.window.showErrorMessage(`Failed to restore workspace: ${String(err)}`);
  }
}
