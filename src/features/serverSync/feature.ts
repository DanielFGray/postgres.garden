/**
 * Connects VS Code commands and file events to the `ServerSync` service.
 * Each callback decodes its arguments and runs one service method.
 */

import * as vscode from "vscode";
import { Effect, Layer, Option, Schema, SchemaGetter } from "effect";
import { VSCodeService } from "../../vscode/service";
import { Workbench } from "../../workbench";
import {
  SERVER_SYNC_CHECKOUT_VERSION,
  SERVER_SYNC_COMMIT,
  SERVER_SYNC_LOAD_COMMIT,
  SERVER_SYNC_REFRESH,
  SERVER_SYNC_REFRESH_FORK_HISTORY,
  SERVER_SYNC_REFRESH_HISTORY,
  SERVER_SYNC_RESTORE_COMMIT,
  SERVER_SYNC_VIEW_COMMIT,
  SERVER_SYNC_VIEW_FORK_SOURCE,
  SERVER_SYNC_WORKSPACE_LOADED,
} from "../constants";
import type { PlaygroundSaveError } from "./playgroundSaver";
import { ServerSync, type ServerSyncError, WorkspaceLoaded } from "./service";

/** A commit id, given directly or as the commit history item a context menu passes. */
const CommitArgument = Schema.Union([
  Schema.String,
  Schema.Struct({ id: Schema.String }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((item) => item.id),
      encode: SchemaGetter.transform((id) => ({ id })),
    }),
  ),
]);

/** A playground hash, given directly or as the fork history item a context menu passes. */
const ForkArgument = Schema.Union([
  Schema.String,
  Schema.Struct({ hash: Schema.String }).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((item) => item.hash),
      encode: SchemaGetter.transform((hash) => ({ hash })),
    }),
  ),
]);

const decodeString = Schema.decodeUnknownOption(Schema.String);

export const ServerSyncFeatureLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { api: vscodeApi, registerCommand } = yield* VSCodeService;
    const { runFork } = yield* Workbench;
    const sync = yield* ServerSync;

    /** Runs `task` without waiting for it. A failure is logged and shown to the user. */
    const run = <A>(
      failure: string,
      task: Effect.Effect<A, ServerSyncError | PlaygroundSaveError>,
    ) =>
      runFork(
        task.pipe(
          Effect.catch((error) =>
            Effect.logError(`[ServerSync] ${failure}:`, error).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  vscodeApi.window.showErrorMessage(`${failure}: ${error.message}`),
                ),
              ),
            ),
          ),
        ),
      );

    /** Registers `command`, which runs `task` with its first argument once `schema` decodes it. */
    const registerDecoded = <A, I>(
      command: string,
      schema: Schema.Codec<A, I>,
      failure: string,
      task: (argument: A) => Effect.Effect<void, ServerSyncError>,
    ) =>
      registerCommand(command, (argument) =>
        Option.match(Schema.decodeUnknownOption(schema)(argument), {
          onNone: () =>
            runFork(Effect.logWarning(`[ServerSync] ${command} got an argument it cannot use`)),
          onSome: (decoded) => run(failure, task(decoded)),
        }),
      );

    yield* registerCommand(SERVER_SYNC_COMMIT, (message) =>
      run("Sync failed", sync.commit(decodeString(message))),
    );
    yield* registerCommand(SERVER_SYNC_REFRESH, () => run("Reload failed", sync.offerReload));
    yield* registerCommand(SERVER_SYNC_REFRESH_HISTORY, () => runFork(sync.refreshCommitHistory));
    yield* registerCommand(SERVER_SYNC_REFRESH_FORK_HISTORY, () =>
      runFork(sync.refreshForkHistory),
    );
    yield* registerCommand(SERVER_SYNC_CHECKOUT_VERSION, () =>
      run("Failed to load versions", sync.checkoutVersion()),
    );
    yield* registerDecoded(
      SERVER_SYNC_VIEW_COMMIT,
      CommitArgument,
      "Failed to show commit",
      sync.viewCommitDiff,
    );
    yield* registerDecoded(
      SERVER_SYNC_LOAD_COMMIT,
      CommitArgument,
      "Failed to open commit",
      sync.openCommit,
    );
    yield* registerDecoded(
      SERVER_SYNC_RESTORE_COMMIT,
      CommitArgument,
      "Failed to restore commit",
      sync.restore,
    );
    yield* registerDecoded(
      SERVER_SYNC_WORKSPACE_LOADED,
      WorkspaceLoaded,
      "Failed to track the loaded workspace",
      sync.workspaceLoaded,
    );
    yield* registerDecoded(
      SERVER_SYNC_VIEW_FORK_SOURCE,
      ForkArgument,
      "Failed to open fork source",
      sync.openFork,
    );

    // A file is changed when its content on disk differs from the baseline, so
    // the watch is on the disk. Editor buffers are not files: a notebook cell
    // has a URI of its own, and an unsaved edit leaves the disk as it was.
    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() => vscodeApi.workspace.createFileSystemWatcher("**/*")),
      (fileWatcher) => Effect.sync(() => fileWatcher.dispose()),
    );
    const mark = (uri: vscode.Uri) => runFork(sync.markChanged(uri));
    watcher.onDidChange(mark);
    watcher.onDidCreate(mark);
    watcher.onDidDelete(mark);
  }),
);
