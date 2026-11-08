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
  Option,
  Ref,
  Schema,
  String as Str,
} from "effect";
import { ApiCaller } from "../../httpapi-client";
import {
  editKeyLink,
  forgetEditKey,
  heldEditKey,
  rememberEditKey,
  takeEditKeyFromUrl,
} from "../../shared/editKey";
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

export class ServerSyncError extends Schema.TaggedError<
  ServerSyncError,
  { readonly brand: unique symbol }
>()("ServerSyncError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const WorkspaceFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
type WorkspaceFile = typeof WorkspaceFile.Type;

/** What `workspaceSwitcher` reports after it loads a commit into the workspace. */
export const WorkspaceLoaded = Schema.Struct({
  commitId: Schema.String,
  playgroundHash: Schema.String,
  files: Schema.Array(WorkspaceFile),
});

/** The playground and commit the workspace holds. Each is none until a load or a save names it. */
interface Position {
  readonly playgroundHash: Option.Option<string>;
  readonly commitId: Option.Option<string>;
}

export class ServerSync extends Context.Service<ServerSync>()("app/ServerSync", {
  make: Effect.gen(function* () {
    const { api: vscodeApi, withProgress } = yield* VSCodeService;
    const { runPromise } = yield* Workbench;
    const loadedWorkspace = yield* LoadedWorkspace;
    const { call } = yield* ApiCaller;

    yield* Effect.sync(takeEditKeyFromUrl);

    const position = yield* Ref.make<Position>({
      playgroundHash: Option.none(),
      commitId: Option.none(),
    });
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

    /**
     * Turn the key this tab holds into ownership of the playground.
     *
     * A key the server will not take is not a failure to report: the save that
     * follows then forks the playground, which is what saving a playground that
     * is not the caller's has always done. The answer says which happened, so a
     * caller does not tell the author their work was kept when it was not. A
     * key that is taken is spent, so it leaves this tab's storage.
     */
    const claimWithEditKey = (hash: string) =>
      call("apiPlaygrounds.claimPlayground", (api) =>
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

    const showWarning = (message: string, ...actions: Array<string>) =>
      Effect.tryPromise({
        try: () => vscodeApi.window.showWarningMessage(message, ...actions),
        catch: toServerSyncError,
      });

    const signIn = (options: vscode.AuthenticationGetSessionOptions) =>
      Effect.tryPromise({
        try: () => vscodeApi.authentication.getSession("github-auth", [], options),
        catch: toServerSyncError,
      });

    /** Saves the workspace as a commit, or as a new playground when it holds none it may write to. */
    const save = Effect.fn("ServerSync.save")(function* (
      message: Option.Option<string>,
      progress: vscode.Progress<{ message?: string }>,
    ) {
      progress.report({ message: "Saving files..." });
      // Flush unsaved editor buffers, so the scan reads what is on screen.
      yield* Effect.tryPromise({
        try: () => vscodeApi.workspace.saveAll(false),
        catch: toServerSyncError,
      });

      progress.report({ message: "Scanning files..." });
      const files = yield* findFiles().pipe(Effect.flatMap(readFiles));
      yield* Effect.log(`[ServerSync] Scanned workspace: ${files.length} files`);
      if (files.length === 0) {
        void vscodeApi.window.showWarningMessage("No files to sync");
        return;
      }

      progress.report({ message: `Uploading ${files.length} files...` });
      const activeFile = vscodeApi.window.activeTextEditor?.document.uri.path ?? null;
      const now = yield* DateTime.now;
      const commitMessage = message.pipe(
        Option.orElse(() => Option.liftPredicate(scm.inputBox.value, Str.isNonEmpty)),
        Option.getOrElse(() => `Workspace snapshot at ${DateTime.formatIso(now)}`),
      );

      const before = yield* Ref.get(position);
      yield* Effect.log("[ServerSync] Sending commit request:", {
        playground_hash: Option.getOrNull(before.playgroundHash),
        fileCount: files.length,
        message: commitMessage,
      });

      // The session cookie, not the local auth provider, says who the caller
      // is, so the server is asked.
      const user = yield* call("apiUsers.me", (api) => api.apiUsers.me({})).pipe(
        Effect.map(({ user }) => Option.fromNullishOr(user)),
        Effect.catch((error) =>
          Effect.logWarning("[ServerSync] Failed to check auth status:", error).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
      const isAuthenticated = Option.isSome(user);
      yield* Effect.log("[ServerSync] Auth check:", {
        isAuthenticated,
        username: Option.getOrNull(Option.map(user, ({ username }) => username)),
      });

      // Which playground is on screen: the URL says so from the first paint,
      // while the position waits for the workspace-loaded notification. A tab
      // opened straight on a playground can be saved before that arrives, and
      // it must save to the playground it is showing.
      const openPlayground = Option.orElse(before.playgroundHash, () =>
        Option.fromNullishOr(getCurrentPlaygroundId()),
      );

      // An account is one way to prove the playground on screen is the
      // caller's to write to; the key this tab holds for it is the other.
      // Signing in while holding a key is how an unclaimed playground gets an
      // owner, so the claim goes first: from then on the account is what the
      // server matches against.
      const keyHeldFor = Option.filter(openPlayground, (hash) => heldEditKey(hash) !== null);
      const claimed = isAuthenticated
        ? yield* Option.match(keyHeldFor, {
            onNone: () => Effect.succeed(false),
            onSome: claimWithEditKey,
          })
        : false;
      const holdsKey = Option.isSome(keyHeldFor) && !claimed;

      // With neither, the save starts a playground of its own. Reading
      // someone else's playground and saving is how a visitor with no account
      // keeps their work, and the server would refuse a commit to a playground
      // they cannot prove is theirs.
      const saveTo = Option.filter(openPlayground, () => isAuthenticated || holdsKey);

      // The two endpoints answer the same five fields and one of their own,
      // so each fills in the other's: one shape means the code below reads a
      // field instead of asking which endpoint it came from.
      const saved = Option.match(saveTo, {
        onSome: (hash) =>
          call("apiPlaygrounds.createCommit", (api) =>
            api.apiPlaygrounds.createCommit({
              params: { hash },
              payload: { message: commitMessage, files, activeFile },
            }),
          ).pipe(
            Effect.map((result) => ({
              ...result,
              edit_key: null,
              expires_at: null,
            })),
          ),
        onNone: () =>
          call("apiPlaygrounds.createPlayground", (api) =>
            api.apiPlaygrounds.createPlayground({
              payload: {
                name: playgroundName(now),
                message: commitMessage,
                description: "New playground",
                files,
                activeFile,
              },
            }),
          ).pipe(Effect.map((result) => ({ ...result, forked: false }))),
      });

      const outcome = yield* saved.pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("[ServerSync] Commit failed:", error);
            if (error.status !== 401) {
              return yield* new ServerSyncError({
                message: `Failed to commit workspace: ${error.status} ${error.message}`,
                cause: error,
              });
            }
            const choice = yield* showWarning(
              "Your session has expired. Please sign in again to sync.",
              "Sign In",
              "Cancel",
            );
            if (choice === "Sign In") {
              yield* signIn({
                createIfNone: true,
                forceNewSession: true,
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
                    vscodeApi.window.showErrorMessage("Authentication failed. Please try again."),
                  ),
                ),
              );
            }
            return Option.none();
          }),
        ),
      );
      if (Option.isNone(outcome)) return;
      const result = outcome.value;

      // The key is answered once and the author keeps it. It must not be the
      // console that keeps a copy as well.
      yield* Effect.log("[ServerSync] Commit successful:", {
        ...result,
        edit_key: result.edit_key === null ? null : "[redacted]",
      });

      const current = yield* Ref.get(position);
      const movedPlayground = !Option.contains(current.playgroundHash, result.playground_hash);

      // A save that moves the workspace to another playground (new or forked)
      // changes which playground is loaded, though no file changes.
      if (movedPlayground) yield* loadedWorkspace.replace(Effect.void);
      yield* Ref.set(position, {
        playgroundHash: Option.some(result.playground_hash),
        commitId: Option.some(result.commit_id),
      });

      // A playground started without an account comes back with the key that
      // holds it. The server answers it once and keeps only its digest, so
      // this is the only moment it can be kept.
      if (result.edit_key !== null) rememberEditKey(result.playground_hash, result.edit_key);

      const playgroundPath = buildPath({
        type: "playground",
        playgroundHash: result.playground_hash,
      });
      if (movedPlayground) {
        yield* Effect.log(
          "[ServerSync] Playground hash changed - updating URL to:",
          result.playground_hash,
          result.forked ? "(forked)" : isAuthenticated ? "(first sync)" : "(anonymous snapshot)",
        );
        // The key stays out of the address bar: session storage holds it.
        window.history.replaceState(null, "", playgroundPath);
      }

      scm.inputBox.value = "";
      yield* resetBaseline(files);

      if (result.forked) {
        void vscodeApi.window.showInformationMessage(
          `Playground forked: ${files.length} file(s) saved. You now own this copy and can continue making commits.`,
        );
      } else if (result.edit_key !== null) {
        yield* offerEditLink({
          fileCount: files.length,
          hash: result.playground_hash,
          link: editKeyLink(`${window.location.origin}${playgroundPath}`, result.edit_key),
          expiresAt: Option.fromNullishOr(result.expires_at),
        });
      } else {
        void vscodeApi.window.showInformationMessage(
          `Workspace synced: ${files.length} file(s) saved`,
        );
      }

      commitHistory.refresh();
      forkHistory.refresh();
      yield* updateStatusBar;
    });

    /**
     * Gives the author of a playground saved without an account its edit link.
     *
     * Such a playground is held by its key and by nothing else: there is no
     * password to recover and no account to sign in to, so the link is the
     * whole claim to it. Hence the clipboard and the warning.
     */
    const offerEditLink = Effect.fnUntraced(function* (saved: {
      readonly fileCount: number;
      readonly hash: string;
      readonly link: string;
      readonly expiresAt: Option.Option<DateTime.Utc>;
    }) {
      const copied = yield* Effect.tryPromise({
        try: () => navigator.clipboard.writeText(saved.link),
        catch: toServerSyncError,
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("[ServerSync] Could not copy the edit link:", error).pipe(
            Effect.as(false),
          ),
        ),
      );

      // The clipboard refuses a write often enough - a browser counts the time
      // since the click - that a message saying the link is on it would, on
      // that day, lose the playground. So the message carries the link itself
      // when the copy did not happen.
      const where = copied
        ? "Your edit link is on the clipboard"
        : `Your edit link is ${saved.link}`;
      const until = Option.match(saved.expiresAt, {
        onNone: () => "",
        onSome: (expiresAt) =>
          ` It is removed on ${DateTime.formatIsoDate(expiresAt)} unless an account claims it.`,
      });
      const action = yield* showWarning(
        `Saved ${saved.fileCount} file(s). ${where} - keep it, because it is the only way back into this playground, and anyone who has it can edit it.${until} Sign in to keep the playground on your account instead.`,
        "Sign In to Keep It",
      );
      if (action !== "Sign In to Keep It") return;

      // The key is what proves this playground is theirs to keep, so the
      // claim goes in while the tab still holds it rather than waiting for the
      // next save.
      yield* Effect.gen(function* () {
        yield* signIn({ createIfNone: true });
        if (heldEditKey(saved.hash) === null) return;
        if (yield* claimWithEditKey(saved.hash)) {
          void vscodeApi.window.showInformationMessage(
            "This playground is on your account now, and the edit link no longer opens it.",
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("[ServerSync] Sign-in to keep the playground did not finish:", error),
        ),
      );
    });

    /** Saves the workspace, with `message` or the input box's text as the commit message. */
    const commit = (message: Option.Option<string>) =>
      withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Syncing workspace to server...",
          cancellable: false,
        },
        (progress) => save(message, progress),
      );

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
      yield* Ref.update(position, (current) => ({
        ...current,
        commitId: Option.some(commitId),
      }));
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
        label: `${Option.contains(commitId, commit.id) ? "✓ " : ""}Version ${index + 1}`,
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

    /** Makes the commit `workspaceSwitcher` just loaded the position and the baseline. */
    const workspaceLoaded = Effect.fn("ServerSync.workspaceLoaded")(function* (
      loaded: typeof WorkspaceLoaded.Type,
    ) {
      yield* Effect.log(
        "[ServerSync] Workspace loaded notification:",
        loaded.commitId,
        loaded.playgroundHash,
        `${loaded.files.length} files`,
      );
      yield* Ref.update(position, (current) => ({
        commitId: Option.some(loaded.commitId),
        playgroundHash: Option.orElse(
          Option.liftPredicate(loaded.playgroundHash, Str.isNonEmpty),
          () => current.playgroundHash,
        ),
      }));
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

/** Where `commitId` stands among `commits`, newest first, counting from 1. The newest when it is not among them. */
const versionOf = (
  commits: ReadonlyArray<{ readonly id: string }>,
  commitId: Option.Option<string>,
) =>
  Option.getOrElse(
    Arr.findFirstIndex(commits, (commit) => Option.contains(commitId, commit.id)),
    () => 0,
  ) + 1;

/** A unique name for a new playground: workspace_YYYYMMDD_HHMMSS_milliseconds. */
const playgroundName = (now: DateTime.Utc) => {
  const date = DateTime.toDate(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `workspace_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${date.getMilliseconds()}`;
};

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
