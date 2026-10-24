/**
 * Workspace Switcher
 * Centralized logic for loading playgrounds/commits into the workspace
 */

import * as vscode from "vscode";
import { IWorkingCopyService, getService } from "@codingame/monaco-vscode-api";
import { DateTime, Effect, Exit, Option, pipe } from "effect";
import * as S from "effect/Schema";
import { httpApiGetPlaygroundCommit, httpApiListPlaygroundCommits } from "../httpapi-client";
import { readInitialData } from "../shared/dehydrate";
import { toError } from "../shared/index.js";
import { CommitDetail } from "../../server/apiSchema.js";
import { navigateTo } from "../shared/navigation";
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
  files: ReadonlyArray<WorkspaceFile>;
  activeFile?: string | null;
}

class WorkspaceError extends S.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: S.String,
  cause: S.optional(S.Unknown),
}) {}

const fromPromise = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceError({ message: toError(cause).message, cause }),
  });

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const deleteWorkspaceFiles = (files: readonly vscode.Uri[]) =>
  Effect.forEach(
    files,
    (file) =>
      fromPromise(() => vscode.workspace.fs.delete(file)).pipe(
        Effect.catch((err) =>
          Effect.logWarning(`[WorkspaceSwitcher] Failed to delete ${file.path}:`, err),
        ),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

const writeWorkspaceFiles = (
  files: ReadonlyArray<{ path: string; content: string }>,
  label: "load" | "restore",
) =>
  Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const uri = vscode.Uri.file(file.path);
        const content = new TextEncoder().encode(file.content);
        const lastSlash = file.path.lastIndexOf("/");
        if (lastSlash > 0) {
          const dirUri = vscode.Uri.file(file.path.substring(0, lastSlash));
          yield* fromPromise(() => vscode.workspace.fs.createDirectory(dirUri)).pipe(Effect.ignore);
        }
        yield* fromPromise(() => vscode.workspace.fs.writeFile(uri, content));
      }).pipe(
        Effect.as(true),
        Effect.tapError((err) =>
          Effect.annotateCurrentSpan({
            error: true,
            "error.message": err instanceof Error ? err.message : String(err),
          }),
        ),
        Effect.catch((err) =>
          Effect.logWarning(
            `[WorkspaceSwitcher] Failed to ${label === "load" ? "load" : "restore"} file ${file.path}:`,
            err,
          ).pipe(Effect.as(false)),
        ),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((results) => results.filter((ok) => !ok).length),
    Effect.withSpan("workspace.writeFiles", { attributes: { fileCount: files.length, label } }),
  );

const openPreferredFile = (
  activeFile: string | null | undefined,
  files: ReadonlyArray<{ path: string }>,
  context: "workspace" | "shared" | "initial",
) =>
  Effect.gen(function* () {
    const fallbackFile = pipe(
      Option.fromNullishOr(files[0]),
      Option.map((file) => file.path),
    );
    const preferredFile = pipe(
      Option.fromNullishOr(activeFile),
      Option.orElse(() => fallbackFile),
    );

    if (Option.isNone(preferredFile)) return;

    const filePath = preferredFile.value;
    const fileUri = vscode.Uri.file(filePath);
    yield* fromPromise(() => vscode.commands.executeCommand(VSCODE_OPEN, fileUri)).pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          if (activeFile) yield* Effect.log(`[WorkspaceSwitcher] Opened active file: ${filePath}`);
          else if (context !== "shared")
            yield* Effect.log(`[WorkspaceSwitcher] Opened first file: ${filePath}`);
        }),
      ),
      Effect.tapError((err) =>
        Effect.annotateCurrentSpan({
          error: true,
          "error.message": err instanceof Error ? err.message : String(err),
        }),
      ),
      Effect.catch((err) =>
        Effect.logWarning(
          activeFile
            ? `[WorkspaceSwitcher] Failed to open active file ${activeFile}:`
            : "[WorkspaceSwitcher] Failed to open first file:",
          err,
        ),
      ),
    );
  }).pipe(Effect.withSpan("workspace.openFile", { attributes: { context } }));

/**
 * Clear all files from the workspace and show the playground browser
 * Used when a playground/commit is not found to prevent loading stale data
 */
const clearWorkspace = Effect.gen(function* () {
  yield* Effect.log("[WorkspaceSwitcher] Clearing workspace...");

  // Close all open editors
  yield* fromPromise(() => vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS));

  // Delete all existing files from the overlay filesystem
  const allFiles = yield* fromPromise(() =>
    vscode.workspace.findFiles("**/*", "**/node_modules/**"),
  );
  yield* deleteWorkspaceFiles(allFiles);

  // NOTE: We do NOT reset userDataProvider here because it would also clear the PGlite database
  // which causes "Can't start a transaction on a closed database" errors.

  // Recreate the /workspace directory to satisfy VSCode workspace folder requirement
  yield* fromPromise(() => vscode.workspace.fs.createDirectory(vscode.Uri.file("/workspace"))).pipe(
    Effect.tap(() => Effect.log("[WorkspaceSwitcher] Recreated /workspace directory")),
    Effect.tapError((err) =>
      Effect.annotateCurrentSpan({
        error: true,
        "error.message": err instanceof Error ? err.message : String(err),
      }),
    ),
    Effect.catch((err) =>
      Effect.logWarning("[WorkspaceSwitcher] Failed to recreate /workspace directory:", err),
    ),
  );

  yield* Effect.log("[WorkspaceSwitcher] Workspace cleared");

  // Open the playground browser to help the user find/create a playground
  yield* fromPromise(() => vscode.commands.executeCommand(PLAYGROUND_SHOW_BROWSER)).pipe(
    Effect.catch((err) =>
      Effect.logWarning("[WorkspaceSwitcher] Failed to open playground browser:", err),
    ),
  );
}).pipe(Effect.withSpan("workspace.clear"));

/**
 * Check if user has existing work (files in workspace or dirty editors)
 */
const hasExistingWork = Effect.gen(function* () {
  const hasDirty = yield* fromPromise(() => getService(IWorkingCopyService)).pipe(
    Effect.map((service) => service.hasDirty),
    Effect.catch((err) => {
      return Effect.logWarning(
        "[WorkspaceSwitcher] Could not access IWorkingCopyService:",
        err,
      ).pipe(Effect.as(false));
    }),
  );

  if (hasDirty) {
    yield* Effect.log("[WorkspaceSwitcher] Found dirty working copies");
    return true;
  }

  const existingFiles = yield* fromPromise(() =>
    vscode.workspace.findFiles("**/*", "**/node_modules/**"),
  );
  if (existingFiles.length > 0) {
    yield* Effect.log(`[WorkspaceSwitcher] Found ${existingFiles.length} existing files`);
    return true;
  }

  return false;
});

/**
 * Load the sample workspace for first-time visitors
 */
const loadSampleWorkspace = Effect.gen(function* () {
  yield* Effect.log("[WorkspaceSwitcher] Loading sample workspace...");

  const template = yield* import.meta.env.DEV
    ? fromPromise(() => import("../example-big-schema")).pipe(
        Effect.map(({ default: getBigSchema }) => getBigSchema()),
      )
    : Effect.succeed(getSmallExampleWorkspace());

  yield* Effect.forEach(
    Object.entries(template.files),
    ([path, content]) =>
      Effect.gen(function* () {
        const uri = vscode.Uri.file(path);
        const lastSlash = path.lastIndexOf("/");
        if (lastSlash > 0) {
          const dirUri = vscode.Uri.file(path.substring(0, lastSlash));
          yield* fromPromise(() => vscode.workspace.fs.createDirectory(dirUri)).pipe(Effect.ignore);
        }
        yield* fromPromise(() =>
          vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)),
        );
      }),
    { concurrency: 1 },
  );

  yield* Effect.forEach(
    template.defaultLayout.editors,
    (editor) =>
      fromPromise(() => vscode.commands.executeCommand(VSCODE_OPEN, vscode.Uri.file(editor.uri))),
    { concurrency: 1 },
  );

  yield* Effect.log("[WorkspaceSwitcher] Sample workspace loaded");
}).pipe(Effect.withSpan("workspace.loadSample"));

// ---------------------------------------------------------------------------
// Helper: decide whether to preserve existing work or load sample
// ---------------------------------------------------------------------------

const loadExistingOrSample = Effect.gen(function* () {
  if (yield* hasExistingWork) {
    yield* Effect.log("[WorkspaceSwitcher] Preserving existing workspace");
  } else {
    yield* Effect.log("[WorkspaceSwitcher] Empty workspace, loading sample...");
    yield* loadSampleWorkspace;
  }
}).pipe(Effect.withSpan("workspace.loadExistingOrSample"));

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Commit data shape returned by the API */
type CommitData = typeof CommitDetail.Type;

/**
 * Core workspace loading logic (runs inside withProgress)
 */
const loadWorkspaceCore = (
  options: LoadWorkspaceOptions,
  progress: vscode.Progress<{ message?: string }>,
) =>
  Effect.gen(function* () {
    const { playgroundHash, commitId, updateUrl = false } = options;
    progress.report({ message: "Fetching data..." });

    let data: CommitData;

    if (commitId) {
      // Loading a specific commit
      const result = yield* httpApiGetPlaygroundCommit(playgroundHash, commitId).pipe(
        Effect.catch((error) => {
          if (error.status === 404) {
            return clearWorkspace.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  vscode.window.showWarningMessage(`Commit not found: ${commitId.substring(0, 8)}`);
                }),
              ),
              Effect.map(() => null),
            );
          }
          return Effect.fail(
            new WorkspaceError({
              message: `Failed to fetch workspace: ${error.status} ${JSON.stringify(error.value)}`,
            }),
          );
        }),
      );
      if (result === null) return;
      data = result;
    } else {
      // Loading a playground's latest commit
      const commits = yield* httpApiListPlaygroundCommits(playgroundHash).pipe(
        Effect.catch((error) => {
          if (error.status === 404) {
            return clearWorkspace.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  vscode.window.showWarningMessage(`Playground not found: ${playgroundHash}`);
                }),
              ),
              Effect.map(() => null),
            );
          }
          if (error.status === 401) {
            return clearWorkspace.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  vscode.window.showWarningMessage(
                    "You don't have permission to view this playground",
                  );
                }),
              ),
              Effect.map(() => null),
            );
          }
          return Effect.fail(
            new WorkspaceError({
              message: `Failed to fetch playground commits: ${error.status} ${JSON.stringify(error.value)}`,
            }),
          );
        }),
      );

      if (commits === null) return;

      if (!Array.isArray(commits) || commits.length === 0) {
        progress.report({ message: "Clearing workspace..." });
        yield* clearWorkspace;
        vscode.window.showInformationMessage(
          `Playground #${playgroundHash} is empty. Create some files and click "Sync to Server" to save your first commit.`,
        );
        return;
      }

      const latestCommit = pipe(
        Option.fromNullishOr(commits[0]),
        Option.getOrThrowWith(
          () => new WorkspaceError({ message: "Invalid playground commit list received" }),
        ),
      );

      data = yield* httpApiGetPlaygroundCommit(playgroundHash, latestCommit.id).pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceError({
              message: `Failed to fetch workspace: ${error.status} ${JSON.stringify(error.value)}`,
            }),
        ),
      );
    }

    const workspace: WorkspaceData = {
      id: data.id,
      name: data.message || `Playground ${playgroundHash}`,
      message: data.message || "",
      timestamp: data.timestamp,
      files: data.files,
      activeFile: data.activeFile,
    };

    yield* Effect.log("[WorkspaceSwitcher] Loading workspace:", workspace.id, workspace.name);
    yield* Effect.log("[WorkspaceSwitcher] Files:", workspace.files.length);

    progress.report({ message: `Loading ${workspace.files.length} files...` });

    // Close all open editors first
    yield* fromPromise(() => vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS));

    // Delete all existing files
    const allFiles = yield* fromPromise(() =>
      vscode.workspace.findFiles("**/*", "**/node_modules/**"),
    );
    yield* deleteWorkspaceFiles(allFiles);

    // Load files from workspace
    yield* writeWorkspaceFiles(workspace.files, "load");
    yield* openPreferredFile(workspace.activeFile, workspace.files, "workspace");

    // Update URL if requested (client-side navigation)
    if (updateUrl) {
      const path = commitId
        ? `/playgrounds/${playgroundHash}/commits/${commitId}`
        : `/playgrounds/${playgroundHash}`;
      navigateTo(path);
    }

    // Notify serverSync extension about the loaded workspace
    yield* fromPromise(() =>
      vscode.commands.executeCommand(SERVER_SYNC_WORKSPACE_LOADED, {
        commitId: workspace.id,
        playgroundHash,
        files: workspace.files,
      }),
    );

    vscode.window.showInformationMessage(
      `Loaded ${workspace.name}: ${workspace.files.length} file(s)`,
    );
  }).pipe(
    // Normalize all errors to WorkspaceError
    Effect.mapError((e) =>
      S.is(WorkspaceError)(e) ? e : new WorkspaceError({ message: toError(e).message, cause: e }),
    ),
  );

/**
 * Load a workspace (playground or specific commit) into the editor
 * This is the central function for all workspace loading operations
 */
export const loadWorkspace = (
  options: LoadWorkspaceOptions,
): Effect.Effect<void, WorkspaceError, never> =>
  Effect.callback<void, WorkspaceError>((resume) => {
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.commitId ? "Loading commit..." : "Loading playground...",
        cancellable: false,
      },
      (progress) =>
        Effect.runPromiseExit(loadWorkspaceCore(options, progress)).then((exit) => {
          resume(Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause));
        }),
    );
  }).pipe(
    Effect.tapError((err) =>
      Effect.annotateCurrentSpan({
        error: true,
        "error.message": err.message,
        "error.type": "workspace_load",
      }),
    ),
    Effect.tapError((err) =>
      Effect.logError("[WorkspaceSwitcher] Error loading workspace:", err).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            vscode.window.showErrorMessage(`Failed to load workspace: ${err.message}`),
          ),
        ),
      ),
    ),
    Effect.withSpan("workspace.load", {
      attributes: { playgroundHash: options.playgroundHash, commitId: options.commitId },
    }),
  );

/**
 * Load workspace from a base64-encoded shared URL
 * Decodes the data parameter and writes files to the workspace
 */
export const loadWorkspaceFromSharedUrl = (data: string): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(base64)));
    const payload = yield* S.decodeEffect(S.fromJsonString(SharedWorkspacePayload))(json);

    yield* Effect.log(
      `[WorkspaceSwitcher] Loading shared workspace: ${payload.files.length} files`,
    );

    yield* fromPromise(() => vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS));

    const allFiles = yield* fromPromise(() =>
      vscode.workspace.findFiles("**/*", "**/node_modules/**"),
    );
    yield* deleteWorkspaceFiles(allFiles);

    yield* writeWorkspaceFiles(payload.files, "load");
    yield* openPreferredFile(payload.activeFile, payload.files, "shared");

    vscode.window.showInformationMessage(
      `Loaded shared workspace: ${payload.files.length} file(s)`,
    );
  }).pipe(
    Effect.tapError((err) =>
      Effect.annotateCurrentSpan({
        error: true,
        "error.message": err instanceof Error ? err.message : String(err),
        "error.type": "shared_workspace",
      }),
    ),
    Effect.tapError((err) =>
      Effect.logError("[WorkspaceSwitcher] Failed to load shared workspace:", err).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            vscode.window.showErrorMessage(
              `Failed to load shared workspace: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
        ),
      ),
    ),
    Effect.ignore,
    Effect.withSpan("workspace.loadFromSharedUrl"),
  );

/**
 * Load workspace from the server-injected initial data.
 * Used during page load.
 */
export const loadWorkspaceFromInitialData: Effect.Effect<void, Error> = Effect.gen(function* () {
  const { route, commit } = readInitialData();

  if (!route && !commit) {
    yield* Effect.log("[WorkspaceSwitcher] No initial state available");
    yield* loadExistingOrSample;
    return;
  }

  if (route?.type === "shared") {
    if (route.data) yield* loadWorkspaceFromSharedUrl(route.data);
    return;
  }

  if (!commit || !route) {
    yield* Effect.log("[WorkspaceSwitcher] No workspace data to load");
    yield* loadExistingOrSample;
    return;
  }

  yield* Effect.log(
    "[WorkspaceSwitcher] Loading from initial data:",
    route.type,
    route.playgroundHash,
    route.commitId,
  );

  // Restoration — errors caught internally (matches original try/catch that doesn't re-throw)
  yield* Effect.gen(function* () {
    yield* fromPromise(() => vscode.commands.executeCommand(WORKBENCH_ACTION_CLOSE_ALL_EDITORS));
    const allFiles = yield* fromPromise(() =>
      vscode.workspace.findFiles("**/*", "**/node_modules/**"),
    );
    yield* deleteWorkspaceFiles(allFiles);

    const errorCount = yield* writeWorkspaceFiles(commit.files, "restore");
    const restoredCount = commit.files.length - errorCount;

    yield* Effect.log(
      `[WorkspaceSwitcher] Restoration complete: ${restoredCount} files restored, ${errorCount} errors`,
    );

    yield* openPreferredFile(commit.activeFile, commit.files, "initial");

    yield* fromPromise(() =>
      vscode.commands.executeCommand(SERVER_SYNC_WORKSPACE_LOADED, {
        commitId: commit.id,
        playgroundHash: route.playgroundHash ?? commit.playground_hash,
        files: commit.files,
      }),
    );

    if (restoredCount > 0) {
      vscode.window.showInformationMessage(
        `Workspace restored: ${restoredCount} file(s) from ${DateTime.makeUnsafe(commit.timestamp).toLocaleString()}`,
      );
    }
  }).pipe(
    Effect.tapError((err) =>
      Effect.annotateCurrentSpan({
        error: true,
        "error.message": err instanceof Error ? err.message : String(err),
        "error.type": "workspace_restore",
      }),
    ),
    Effect.tapError((err) =>
      Effect.logError("[WorkspaceSwitcher] Failed to restore workspace:", err).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            vscode.window.showErrorMessage(`Failed to restore workspace: ${String(err)}`),
          ),
        ),
      ),
    ),
    Effect.ignore,
  );
}).pipe(Effect.withSpan("workspace.loadFromInitialData"));
