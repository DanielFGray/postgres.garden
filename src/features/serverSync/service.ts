/**
 * Saves the workspace to the server and shows it as a source control view,
 * with the commit history and fork history of the playground it holds.
 *
 * A file is changed while its content differs from the baseline (see
 * `baseline.ts`). Loading, saving or restoring a commit makes that commit the
 * baseline, so nothing is changed after it.
 */

import * as vscode from "vscode";
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Equal,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  String as Str,
} from "effect";
import { ApiCaller } from "../../httpapi-client";
import { takeEditKeyFromUrl } from "../../shared/editKey";
import { toErrorMessage } from "../../shared/errors";
import { navigateTo } from "../../shared/navigation";
import { buildPath, getCurrentPlaygroundId } from "../../shared/routes";
import { VSCodeService } from "../../vscode/service";
import { Workbench } from "../../workbench";
import {
  SERVER_SYNC_CHECKOUT_VERSION,
  SERVER_SYNC_COMMIT,
  SERVER_SYNC_COMMIT_HISTORY,
  SERVER_SYNC_FORK_HISTORY,
  VSCODE_DIFF,
  VSCODE_OPEN,
} from "../constants";
import { LoadedWorkspace } from "../loadedWorkspace";
import { BaselineContentProvider, quickDiffProvider } from "./baseline";
import {
  type CommitHistoryItem,
  commitTreeItem,
  type ForkHistoryItem,
  forkTreeItem,
  ListTreeProvider,
} from "./historyTree";
import { PlaygroundSaver, type Saved, WorkspaceFile } from "./playgroundSaver";
import {
  afterLoad,
  afterNewestHeadRead,
  afterRestore,
  afterSave,
  type Position,
  saveTarget,
  unknownPosition,
} from "./position";

export class ServerSyncError extends Schema.TaggedError<
  ServerSyncError,
  { readonly brand: unique symbol }
>()("ServerSyncError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * What `workspaceSwitcher` reports after it fills the workspace. `playground`
 * names the playground that holds `files`, and is none for files that no
 * playground holds, such as the sample or a shared link.
 */
export const WorkspaceLoaded = Schema.Struct({
  files: Schema.Array(WorkspaceFile),
  playground: Schema.OptionFromNullOr(
    Schema.Struct({
      playgroundHash: Schema.String,
      /** The commit that holds `files`. None for a playground with no commits. */
      commitId: Schema.OptionFromNullOr(Schema.String),
      /** The playground's head, read with the commit. */
      head: Schema.OptionFromNullOr(Schema.String),
    }),
  ),
});

export class ServerSync extends Context.Service<ServerSync>()("app/ServerSync", {
  make: Effect.gen(function* () {
    const { api: vscodeApi, withProgress } = yield* VSCodeService;
    const { runPromise } = yield* Workbench;
    const loadedWorkspace = yield* LoadedWorkspace;
    const { call } = yield* ApiCaller;
    const saver = yield* PlaygroundSaver;

    yield* Effect.sync(takeEditKeyFromUrl);

    const position = yield* Ref.make<Position>(unknownPosition);
    /** Baseline content by file path. */
    const baseline = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    /** Changed files by URI. */
    const changed = yield* Ref.make<ReadonlyMap<string, vscode.Uri>>(new Map());

    // VS Code reads the baseline and the history views through callbacks
    // that expect Promises, so those callbacks run in the workbench runtime.
    const baselineContent = new BaselineContentProvider((path) =>
      runPromise(
        Ref.get(baseline).pipe(
          Effect.map((files) => Option.getOrElse(Option.fromNullishOr(files.get(path)), () => "")),
        ),
      ),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscodeApi.workspace.registerTextDocumentContentProvider(
          BaselineContentProvider.scheme,
          baselineContent,
        ),
      ),
      (registration) =>
        Effect.sync(() => {
          registration.dispose();
          baselineContent.dispose();
        }),
    );

    const scm = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const control = vscodeApi.scm.createSourceControl(
          "server-sync",
          "Server Sync",
          vscodeApi.workspace.workspaceFolders?.[0]?.uri,
        );
        control.inputBox.placeholder = "Commit message (optional)";
        control.acceptInputCommand = {
          command: SERVER_SYNC_COMMIT,
          title: "Sync to Server",
        };
        control.actionButton = {
          command: { command: SERVER_SYNC_COMMIT, title: "Sync to Server" },
          enabled: true,
        };
        control.quickDiffProvider = quickDiffProvider;
        return control;
      }),
      (control) => Effect.sync(() => control.dispose()),
    );
    const workingTree = yield* Effect.acquireRelease(
      Effect.sync(() => scm.createResourceGroup("working-tree", "Changes")),
      (group) => Effect.sync(() => group.dispose()),
    );

    const findFiles = (exclude?: string) =>
      Effect.tryPromise({
        try: () => vscodeApi.workspace.findFiles("**/*", exclude),
        catch: toServerSyncError,
      });
    const workspaceFiles = findFiles("**/node_modules/**");

    const readText = (uri: vscode.Uri) =>
      Effect.tryPromise({
        try: () => vscodeApi.workspace.fs.readFile(uri),
        catch: toServerSyncError,
      }).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));

    /** Reads each of `uris`. A file that cannot be read is logged and left out. */
    const readFiles = (uris: ReadonlyArray<vscode.Uri>) =>
      Effect.forEach(uris, (uri) =>
        readText(uri).pipe(
          Effect.map((content) => Option.some<WorkspaceFile>({ path: uri.path, content })),
          Effect.catch((error) =>
            Effect.logWarning(`[ServerSync] Failed to read file ${uri.path}:`, error).pipe(
              Effect.as(Option.none<WorkspaceFile>()),
            ),
          ),
        ),
      ).pipe(Effect.map(Arr.getSomes));

    const showChanges = Ref.get(changed).pipe(
      Effect.map((files) => {
        workingTree.resourceStates = Array.from(files.values(), (uri) => ({
          resourceUri: uri,
          command: { title: "Open", command: VSCODE_OPEN, arguments: [uri] },
        }));
        scm.count = files.size;
      }),
    );

    const refreshQuickDiff = workspaceFiles.pipe(
      Effect.map((uris) => uris.forEach((uri) => baselineContent.refresh(uri))),
    );

    /** Makes `files` the baseline, so that no file is changed. */
    const resetBaseline = Effect.fnUntraced(function* (files: ReadonlyArray<WorkspaceFile>) {
      yield* Ref.set(baseline, new Map(files.map((file) => [file.path, file.content])));
      yield* Ref.set(changed, new Map());
      yield* showChanges;
      yield* refreshQuickDiff;
    });

    const currentPlayground = Ref.get(position).pipe(
      Effect.flatMap(({ playgroundHash }) =>
        Effect.fromOption(
          playgroundHash,
          () => new ServerSyncError({ message: "No playground loaded" }),
        ),
      ),
    );

    const listCommits = (hash: string) =>
      call("apiPlaygrounds.listCommits", (api) =>
        api.apiPlaygrounds.listCommits({ params: { hash } }),
      );

    const loadCommitHistory = Effect.gen(function* () {
      const { playgroundHash, commitId } = yield* Ref.get(position);
      return yield* Option.match(playgroundHash, {
        onNone: () =>
          Effect.log("[ServerSync] No playground loaded, commit history is empty").pipe(
            Effect.as(Arr.empty<CommitHistoryItem>()),
          ),
        onSome: (hash) =>
          listCommits(hash).pipe(
            Effect.tap((commits) =>
              Effect.log(`[ServerSync] Showing ${commits.length} commits for playground ${hash}`),
            ),
            Effect.map((commits) =>
              commits.map((commit): CommitHistoryItem => ({
                id: commit.id,
                message: commit.message,
                timestamp: commit.timestamp,
                username: Option.fromNullishOr(commit.username),
                isCurrent: Option.contains(commitId, commit.id),
              })),
            ),
            Effect.catch((error) =>
              Effect.logError("[ServerSync] Error loading commits:", error).pipe(
                Effect.as(Arr.empty<CommitHistoryItem>()),
              ),
            ),
          ),
      });
    });

    /**
     * The fork chain that ends at `hash`, oldest first. A playground that
     * cannot be loaded ends the chain there, keeping the newer forks.
     */
    const forkChain = (hash: string, current: string): Effect.Effect<Array<ForkHistoryItem>> =>
      call("apiPlaygrounds.playgroundByHash", (api) =>
        api.apiPlaygrounds.playgroundByHash({ params: { hash } }),
      ).pipe(
        Effect.flatMap((playground) => {
          const fork: ForkHistoryItem = {
            hash: playground.hash,
            name: playground.name ?? "Untitled",
            owner: Option.map(Option.fromNullishOr(playground.user), (user) => user.username),
            isCurrent: playground.hash === current,
          };
          return Option.fromNullishOr(playground.fork_of).pipe(
            Option.flatMapNullishOr((source) => source.hash),
            Option.match({
              onNone: () => Effect.succeed([fork]),
              onSome: (source) =>
                forkChain(source, current).pipe(Effect.map((older) => [...older, fork])),
            }),
          );
        }),
        Effect.catch((error) =>
          Effect.logError("[ServerSync] Error loading fork history:", error).pipe(
            Effect.as(Arr.empty<ForkHistoryItem>()),
          ),
        ),
      );

    const loadForkHistory = Ref.get(position).pipe(
      Effect.flatMap(({ playgroundHash }) =>
        Option.match(playgroundHash, {
          onNone: () => Effect.succeed(Arr.empty<ForkHistoryItem>()),
          onSome: (hash) => forkChain(hash, hash),
        }),
      ),
      Effect.tap((chain) => Effect.log(`[ServerSync] Fork history: ${chain.length} items`)),
    );

    const commitHistory = new ListTreeProvider(() => runPromise(loadCommitHistory), commitTreeItem);
    const forkHistory = new ListTreeProvider(() => runPromise(loadForkHistory), forkTreeItem);
    const showTree = <Item>(id: string, provider: ListTreeProvider<Item>) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          vscodeApi.window.createTreeView(id, {
            treeDataProvider: provider,
            showCollapseAll: false,
          }),
        ),
        (view) =>
          Effect.sync(() => {
            view.dispose();
            provider.dispose();
          }),
      );
    yield* showTree(SERVER_SYNC_COMMIT_HISTORY, commitHistory);
    yield* showTree(SERVER_SYNC_FORK_HISTORY, forkHistory);

    const updateStatusBar = Effect.gen(function* () {
      const { playgroundHash, commitId } = yield* Ref.get(position);
      const commits = yield* Option.match(playgroundHash, {
        onNone: () => Effect.succeedNone,
        onSome: (hash) =>
          listCommits(hash).pipe(
            Effect.asSome,
            Effect.catch((error) =>
              Effect.logWarning(
                "[ServerSync] Could not load commits for the status bar:",
                error,
              ).pipe(Effect.as(Option.none())),
            ),
          ),
      });
      scm.statusBarCommands = Option.getOrUndefined(
        Option.map(commits, (list) => [
          {
            command: SERVER_SYNC_CHECKOUT_VERSION,
            title: `↕ Version ${versionOf(list, commitId)}/${list.length}`,
            tooltip: "Click to checkout another version",
          },
        ]),
      );
    });

    const showWarning = (message: string, ...actions: Array<string>) =>
      Effect.tryPromise({
        try: () => vscodeApi.window.showWarningMessage(message, ...actions),
        catch: toServerSyncError,
      });

    /** Reads the workspace and sends it to the server. None when the workspace holds no files. */
    const upload = Effect.fnUntraced(function* (
      message: Option.Option<string>,
      progress: vscode.Progress<{ message?: string }>,
    ) {
      const target = yield* Ref.get(position).pipe(
        Effect.flatMap((current) =>
          Effect.fromOption(
            saveTarget(current, Option.fromNullishOr(getCurrentPlaygroundId())),
            () =>
              new ServerSyncError({
                message: "The playground is still loading. Save again when its files appear.",
              }),
          ),
        ),
      );

      progress.report({ message: "Saving files..." });
      // Flush unsaved editor buffers, so the scan reads what is on screen.
      yield* Effect.tryPromise({
        try: () => vscodeApi.workspace.saveAll(false),
        catch: toServerSyncError,
      });

      progress.report({ message: "Scanning files..." });
      const files = yield* findFiles().pipe(Effect.flatMap(readFiles));
      yield* Effect.log(`[ServerSync] Scanned workspace: ${files.length} files`);
      if (files.length === 0) return Option.none();

      progress.report({ message: `Uploading ${files.length} files...` });
      const now = yield* DateTime.now;
      const outcome = yield* saver.upload({
        files,
        message: message.pipe(
          Option.orElse(() => Option.liftPredicate(scm.inputBox.value, Str.isNonEmpty)),
          Option.getOrElse(() => `Workspace snapshot at ${DateTime.formatIso(now)}`),
        ),
        activeFile: Option.fromNullishOr(vscodeApi.window.activeTextEditor?.document.uri.path),
        openPlayground: target.openPlayground,
        basis: target.basis,
      });
      return Option.some({ outcome, files });
    });

    /** Makes the commit that a save just made the position and the baseline. */
    const applySaved = Effect.fnUntraced(function* (
      saved: typeof Saved.Type,
      files: ReadonlyArray<WorkspaceFile>,
    ) {
      const { playgroundHash } = yield* Ref.get(position);
      // A save that moves the workspace to another playground (new or forked)
      // changes which playground is loaded, though no file changes.
      if (!Option.contains(playgroundHash, saved.playgroundHash)) {
        yield* loadedWorkspace.replace(Effect.void);
        yield* Effect.log(
          "[ServerSync] Playground changed - updating URL to:",
          saved.playgroundHash,
        );
        // The key stays out of the address bar: session storage holds it.
        window.history.replaceState(
          null,
          "",
          buildPath({ type: "playground", playgroundHash: saved.playgroundHash }),
        );
      }
      yield* Ref.set(position, afterSave(saved));
      scm.inputBox.value = "";
      yield* resetBaseline(files);
      commitHistory.refresh();
      forkHistory.refresh();
      yield* updateStatusBar;
    });

    /**
     * Saves the workspace, with `message` or the input box's text as the
     * commit message. The progress notification closes before a dialog about
     * the outcome opens, because a dialog waits for an answer.
     */
    const commit = Effect.fn("ServerSync.commit")((message: Option.Option<string>) =>
      saveOnce(message).pipe(Effect.repeat({ while: (again) => again })),
    );

    /** One save and what follows it. True when the author asked to send the save again. */
    const saveOnce = Effect.fnUntraced(function* (message: Option.Option<string>) {
      const uploaded = yield* withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing workspace to server...",
          cancellable: false,
        },
        (progress) => upload(message, progress),
      );
      return yield* Option.match(uploaded, {
        onNone: () =>
          Effect.sync(() => void vscodeApi.window.showWarningMessage("No files to sync")).pipe(
            Effect.as(false),
          ),
        onSome: ({ outcome, files }) =>
          Match.valueTags(outcome, {
            Saved: (saved) =>
              applySaved(saved, files).pipe(
                Effect.andThen(saver.announce(saved)),
                Effect.as(false),
              ),
            SessionExpired: (expired) => saver.announce(expired).pipe(Effect.as(false)),
            Stale: () => offerNewestVersion,
          }),
      });
    });

    /**
     * Asks what to do with a save the server refused because someone else saved
     * after the head this tab last saw. True when the author chose to send it
     * again on top of the head as it is now.
     */
    const offerNewestVersion = Effect.gen(function* () {
      const hash = yield* currentPlayground;
      const choice = yield* showWarning(
        "This playground has a newer version than the one you started from. Reload to see it, which replaces your changes, or save yours as the newest version.",
        "Reload",
        "Save as Newest Version",
      );
      if (choice === "Reload") {
        // The playground's own address opens its head, even when the address
        // bar names an older commit.
        window.location.assign(buildPath({ type: "playground", playgroundHash: hash }));
        return false;
      }
      if (choice !== "Save as Newest Version") return false;
      // The author chose to go on top of whatever the head is now, so reading it
      // here is the answer to the dialog, not a way around the check.
      const playground = yield* call("apiPlaygrounds.playgroundByHash", (api) =>
        api.apiPlaygrounds.playgroundByHash({ params: { hash } }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new ServerSyncError({
              message: `Failed to read the newest version: ${error.status} ${error.message}`,
              cause: error,
            }),
        ),
      );
      yield* Ref.update(position, (current) =>
        afterNewestHeadRead(current, Option.fromNullishOr(playground.head_commit_id)),
      );
      return true;
    });

    /** Replaces the workspace with the files of `commitId`, which becomes the baseline. */
    const restore = Effect.fn("ServerSync.restore")(function* (commitId: string) {
      const confirm = yield* showWarning(
        "This will restore all files from this commit. Current changes will be overwritten. Continue?",
        "Restore",
        "Cancel",
      );
      if (confirm !== "Restore") return;

      const hash = yield* currentPlayground;
      const restored = yield* call("apiPlaygrounds.getCommit", (api) =>
        api.apiPlaygrounds.getCommit({
          params: { hash, commit_id: commitId },
        }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new ServerSyncError({
              message: `Failed to load commit: ${error.status} ${error.message}`,
              cause: error,
            }),
        ),
      );

      yield* loadedWorkspace.replace(
        Effect.gen(function* () {
          const existing = yield* workspaceFiles;
          yield* Effect.forEach(existing, (file) =>
            Effect.tryPromise({
              try: () => vscodeApi.workspace.fs.delete(file),
              catch: toServerSyncError,
            }).pipe(
              Effect.catch((error) => Effect.logWarning(`Failed to delete ${file.path}:`, error)),
            ),
          );
          yield* Effect.forEach(restored.files, (file) =>
            Effect.gen(function* () {
              const directory = vscode.Uri.file(file.path.substring(0, file.path.lastIndexOf("/")));
              // A directory that already exists is not a failure here.
              yield* Effect.tryPromise(() =>
                vscodeApi.workspace.fs.createDirectory(directory),
              ).pipe(Effect.ignore);
              yield* Effect.tryPromise({
                try: () =>
                  vscodeApi.workspace.fs.writeFile(
                    vscode.Uri.file(file.path),
                    new TextEncoder().encode(file.content),
                  ),
                catch: toServerSyncError,
              });
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Failed to restore file ${file.path}:`, error),
              ),
            ),
          );
        }),
      );

      void vscodeApi.window.showInformationMessage(
        `Restored ${restored.files.length} files from commit`,
      );
      yield* Ref.update(position, (current) => afterRestore(current, commitId));
      yield* resetBaseline(restored.files);
      commitHistory.refresh();
    });

    /** Shows one file of `commitId` as a diff against the commit's parent. */
    const viewCommitDiff = Effect.fn("ServerSync.viewCommitDiff")(function* (commitId: string) {
      const hash = yield* currentPlayground;
      const diff = yield* withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading commit diff...",
          cancellable: false,
        },
        () =>
          call("apiPlaygrounds.getCommitDiff", (api) =>
            api.apiPlaygrounds.getCommitDiff({
              params: { hash, commit_id: commitId },
            }),
          ),
      ).pipe(
        Effect.mapError(
          (error) =>
            new ServerSyncError({
              message: `Failed to load commit diff: ${error.status} ${error.message}`,
              cause: error,
            }),
        ),
      );
      yield* Effect.log("[ServerSync] Viewing commit diff:", commitId, {
        added: diff.added.length,
        modified: diff.modified.length,
        deleted: diff.deleted.length,
      });

      const items = diffItems(diff);
      if (items.length === 0) {
        void vscodeApi.window.showInformationMessage("No changes in this commit");
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
      if (selected === undefined) return;

      const { file } = selected;
      const scheme = "server-sync-commit";
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vscodeApi.workspace.registerTextDocumentContentProvider(scheme, {
            provideTextDocumentContent: (uri) =>
              uri.query === "parent" ? file.parentContent : file.content,
          }),
        ),
        () =>
          Effect.tryPromise({
            try: () =>
              vscodeApi.commands.executeCommand(
                VSCODE_DIFF,
                vscode.Uri.parse(`${scheme}:${file.path}?parent`),
                vscode.Uri.parse(`${scheme}:${file.path}?commit`),
                `${file.path} (Commit ${commitId.substring(0, 8)})`,
              ),
            catch: toServerSyncError,
          }),
        (registration) => Effect.sync(() => registration.dispose()),
      );
    });

    /** Lets the user pick a commit of the playground and opens it. */
    const checkoutVersion = Effect.fn("ServerSync.checkoutVersion")(function* () {
      const hash = yield* currentPlayground;
      const { commitId } = yield* Ref.get(position);
      const commits = yield* listCommits(hash).pipe(
        Effect.mapError(
          (error) =>
            new ServerSyncError({
              message: "Failed to load commits",
              cause: error,
            }),
        ),
      );
      const items = commits.map((commit, index) => ({
        label: `${Option.contains(commitId, commit.id) ? "✓ " : ""}Version ${versionAt(commits, index)}`,
        description: commit.message || `Commit ${commit.id.substring(0, 8)}`,
        detail: `${commit.username ?? "Unknown"} • ${DateTime.formatLocal(DateTime.makeUnsafe(commit.timestamp))}`,
        commitId: commit.id,
      }));
      const selected = yield* Effect.tryPromise({
        try: () =>
          vscodeApi.window.showQuickPick(items, {
            placeHolder: `Select a version to checkout (currently at ${versionOf(commits, commitId)}/${commits.length})`,
            matchOnDescription: true,
            matchOnDetail: true,
          }),
        catch: toServerSyncError,
      });
      if (selected === undefined || Option.contains(commitId, selected.commitId)) return;
      navigateTo(
        buildPath({
          type: "commit",
          playgroundHash: hash,
          commitId: selected.commitId,
        }),
      );
    });

    /** Opens `commitId` of the playground the workspace holds, through the router. */
    const openCommit = Effect.fn("ServerSync.openCommit")(function* (commitId: string) {
      const hash = yield* currentPlayground;
      const path = buildPath({
        type: "commit",
        playgroundHash: hash,
        commitId,
      });
      yield* Effect.log("[ServerSync] Navigating to commit URL:", path);
      navigateTo(path);
    });

    /** Opens the playground `hash`, which a fork history item names, through the router. */
    const openFork = Effect.fn("ServerSync.openFork")(function* (hash: string) {
      const path = buildPath({ type: "playground", playgroundHash: hash });
      yield* Effect.log("[ServerSync] Opening fork source:", path);
      navigateTo(path);
    });

    /**
     * Makes the files `workspaceSwitcher` just loaded the baseline, and their
     * commit the position. Loaded files are not changes, even when no commit
     * holds them: the author has not edited them yet.
     */
    const workspaceLoaded = Effect.fn("ServerSync.workspaceLoaded")(function* (
      loaded: typeof WorkspaceLoaded.Type,
    ) {
      yield* Effect.log(
        "[ServerSync] Workspace loaded notification:",
        Option.getOrNull(loaded.playground),
        `${loaded.files.length} files`,
      );
      yield* Ref.set(position, afterLoad(loaded.playground));
      yield* resetBaseline(loaded.files);
      commitHistory.refresh();
      forkHistory.refresh();
      yield* updateStatusBar;
    });

    /** Adds `uri` to the changed files, or removes it, by comparing it with the baseline. */
    const markChanged = Effect.fn("ServerSync.markChanged")(function* (uri: vscode.Uri) {
      // Other documents, such as the baseline's own, are not workspace files.
      if (uri.scheme !== "file") return;

      // A file that cannot be read counts as absent: deleted when the
      // baseline holds it, unchanged when it does not.
      const content = yield* Effect.option(readText(uri));
      const original = Option.fromNullishOr((yield* Ref.get(baseline)).get(uri.path));
      const isChanged = !Equal.equals(content, original);

      const key = uri.toString();
      const moved = yield* Ref.modify(changed, (files) => {
        if (files.has(key) === isChanged) return [false, files];
        const next = new Map(files);
        if (isChanged) next.set(key, uri);
        else next.delete(key);
        return [true, next];
      });
      if (!moved) return;

      yield* showChanges;
      const what = !isChanged
        ? "File reverted to baseline"
        : Option.isSome(content)
          ? "File changed"
          : "File deleted";
      yield* Effect.log(`[ServerSync] ${what}: ${uri.path}`);
    });

    /** Offers to reload the page, which loads the workspace from the server again. */
    const offerReload = Effect.gen(function* () {
      const choice = yield* Effect.tryPromise({
        try: () =>
          vscodeApi.window.showInformationMessage("Reloading workspace from server...", "Reload"),
        catch: toServerSyncError,
      });
      if (choice === "Reload") window.location.reload();
    });

    // Until a load names a commit, the workspace as it opened is the
    // baseline, the way a fresh clone has no changes.
    const initial = yield* workspaceFiles.pipe(Effect.flatMap(readFiles));
    yield* Ref.set(baseline, new Map(initial.map((file) => [file.path, file.content])));
    yield* showChanges;

    return {
      commit,
      restore,
      viewCommitDiff,
      checkoutVersion,
      openCommit,
      openFork,
      workspaceLoaded,
      markChanged,
      offerReload,
      refreshCommitHistory: Effect.sync(() => commitHistory.refresh()),
      refreshForkHistory: Effect.sync(() => forkHistory.refresh()),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const toServerSyncError = (cause: unknown) =>
  new ServerSyncError({ message: toErrorMessage(cause), cause });

/**
 * The version number of the commit at `index` in `commits`, which the server
 * lists newest first. Versions count from the oldest, so the latest save is
 * the highest number.
 */
const versionAt = (commits: ReadonlyArray<{ readonly id: string }>, index: number) =>
  commits.length - index;

/** The version number of `commitId` among `commits`. The newest when it is not among them. */
const versionOf = (
  commits: ReadonlyArray<{ readonly id: string }>,
  commitId: Option.Option<string>,
) =>
  versionAt(
    commits,
    Option.getOrElse(
      Arr.findFirstIndex(commits, (commit) => Option.contains(commitId, commit.id)),
      () => 0,
    ),
  );

/** One file of a commit, in the commit and in its parent. An absent side is empty. */
interface CommitFileChange {
  readonly path: string;
  readonly content: string;
  readonly parentContent: string;
}

interface DiffFileItem extends vscode.QuickPickItem {
  readonly file: CommitFileChange;
}

const diffItems = (diff: {
  readonly added: ReadonlyArray<WorkspaceFile>;
  readonly modified: ReadonlyArray<CommitFileChange>;
  readonly deleted: ReadonlyArray<WorkspaceFile>;
}): Array<DiffFileItem> => [
  ...diff.added.map((file) => ({
    label: `$(diff-added) ${file.path}`,
    description: "Added",
    file: { ...file, parentContent: "" },
  })),
  ...diff.modified.map((file) => ({
    label: `$(diff-modified) ${file.path}`,
    description: "Modified",
    file,
  })),
  ...diff.deleted.map((file) => ({
    label: `$(diff-removed) ${file.path}`,
    description: "Deleted",
    file: { path: file.path, content: "", parentContent: file.content },
  })),
];
