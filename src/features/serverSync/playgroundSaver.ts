/**
 * Uploads the workspace to the server, and tells the author what became of
 * it.
 *
 * Which endpoint a save goes to depends on whether the caller may write to the
 * playground on screen: an account proves it, and so does the edit key this
 * tab holds for a playground started without an account. With neither, the
 * save starts a playground of its own.
 */

import * as vscode from "vscode";
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from "effect";
import { ApiCaller } from "../../httpapi-client";
import { editKeyLink, forgetEditKey, heldEditKey, rememberEditKey } from "../../shared/editKey";
import { toErrorMessage } from "../../shared/errors";
import { buildPath } from "../../shared/routes";
import { VSCodeService } from "../../vscode/service";

export class PlaygroundSaveError extends Schema.TaggedError<
  PlaygroundSaveError,
  { readonly brand: unique symbol }
>()("PlaygroundSaveError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** A file of the workspace, by its path. */
export const WorkspaceFile = Schema.Struct({ path: Schema.String, content: Schema.String });
export type WorkspaceFile = typeof WorkspaceFile.Type;

/** What a save sends. */
export const SaveRequest = Schema.Struct({
  files: Schema.Array(WorkspaceFile),
  message: Schema.String,
  activeFile: Schema.Option(Schema.String),
  /** The playground on screen, which the save goes to when the caller may write to it. */
  openPlayground: Schema.Option(Schema.String),
  /** The head this tab last saw of the open playground, which the save goes on top of. */
  basis: Schema.Option(Schema.String),
});
export type SaveRequest = typeof SaveRequest.Type;

/** The server kept the files as `commitId` of `playgroundHash`. */
export const Saved = Schema.TaggedStruct("Saved", {
  playgroundHash: Schema.String,
  commitId: Schema.String,
  fileCount: Schema.Int,
  /** The save went to a copy of a playground the caller may not write to. */
  forked: Schema.Boolean,
  /** The key that holds a playground started without an account. */
  editKey: Schema.Option(Schema.String),
  /** When a playground no account owns is removed. */
  expiresAt: Schema.Option(Schema.DateTimeUtc),
});

/** The server refused the session, so nothing was saved. */
export const SessionExpired = Schema.TaggedStruct("SessionExpired", {});

/** Someone saved the playground after the head the save named, so nothing was saved. */
export const Stale = Schema.TaggedStruct("Stale", {});

export const SaveOutcome = Schema.Union([Saved, SessionExpired, Stale]);
export type SaveOutcome = typeof SaveOutcome.Type;

export class PlaygroundSaver extends Context.Service<PlaygroundSaver>()("app/PlaygroundSaver", {
  make: Effect.gen(function* () {
    const { api: vscodeApi } = yield* VSCodeService;
    const { call } = yield* ApiCaller;

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
        catch: toSaveError,
      });

    const showInformation = (message: string) =>
      Effect.sync(() => void vscodeApi.window.showInformationMessage(message));

    const signIn = (options: vscode.AuthenticationGetSessionOptions) =>
      Effect.tryPromise({
        try: () => vscodeApi.authentication.getSession("github-auth", [], options),
        catch: toSaveError,
      });

    /** Sends `request` to the server. A refused session is an outcome, not a failure. */
    const upload = Effect.fn("PlaygroundSaver.upload")(function* (request: SaveRequest) {
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
      yield* Effect.log("[ServerSync] Sending commit request:", {
        playground_hash: Option.getOrNull(request.openPlayground),
        fileCount: request.files.length,
        message: request.message,
        username: Option.getOrNull(Option.map(user, ({ username }) => username)),
      });

      // Signing in while holding a key is how an unclaimed playground gets an
      // owner, so the claim goes first: from then on the account is what the
      // server matches against.
      const keyHeldFor = Option.filter(
        request.openPlayground,
        (hash) => heldEditKey(hash) !== null,
      );
      const claimed = isAuthenticated
        ? yield* Option.match(keyHeldFor, {
            onNone: () => Effect.succeed(false),
            onSome: claimWithEditKey,
          })
        : false;
      const holdsKey = Option.isSome(keyHeldFor) && !claimed;

      // Reading someone else's playground and saving is how a visitor with no
      // account keeps their work, and the server would refuse a commit to a
      // playground they cannot prove is theirs.
      const saveTo = Option.filter(request.openPlayground, () => isAuthenticated || holdsKey);
      const payload = {
        message: request.message,
        files: request.files,
        activeFile: Option.getOrNull(request.activeFile),
      };
      const now = yield* DateTime.now;

      const sent = Option.match(saveTo, {
        onSome: (hash) =>
          call("apiPlaygrounds.createCommit", (api) =>
            api.apiPlaygrounds.createCommit({
              params: { hash },
              payload: { ...payload, basis: Option.getOrNull(request.basis) },
            }),
          ).pipe(
            Effect.map((result): typeof Saved.Type => ({
              _tag: "Saved",
              playgroundHash: result.playground_hash,
              commitId: result.commit_id,
              fileCount: request.files.length,
              forked: result.forked,
              editKey: Option.none(),
              expiresAt: Option.none(),
            })),
          ),
        onNone: () =>
          call("apiPlaygrounds.createPlayground", (api) =>
            api.apiPlaygrounds.createPlayground({
              payload: { ...payload, name: playgroundName(now), description: "New playground" },
            }),
          ).pipe(
            Effect.map((result): typeof Saved.Type => ({
              _tag: "Saved",
              playgroundHash: result.playground_hash,
              commitId: result.commit_id,
              fileCount: request.files.length,
              forked: false,
              editKey: Option.fromNullishOr(result.edit_key),
              expiresAt: Option.map(
                Option.fromNullishOr(result.expires_at),
                DateTime.fromDateUnsafe,
              ),
            })),
          ),
      });

      return yield* sent.pipe(
        Effect.tap(keepEditKey),
        Effect.catch((error) =>
          Effect.logError("[ServerSync] Commit failed:", error).pipe(
            Effect.andThen(
              Match.value(error.status).pipe(
                Match.when(401, () => Effect.succeed<SaveOutcome>({ _tag: "SessionExpired" })),
                // Only createCommit answers 409, and only when the basis is no
                // longer the head.
                Match.when(409, () => Effect.succeed<SaveOutcome>({ _tag: "Stale" })),
                Match.orElse(() =>
                  Effect.fail(
                    new PlaygroundSaveError({
                      message: `Failed to commit workspace: ${error.status} ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });

    /**
     * Keeps the key of a playground started without an account. The server
     * answers it once and keeps only its digest, so this is the only moment it
     * can be kept, and the author is the only one who keeps it: the console
     * log does not.
     */
    const keepEditKey = (saved: typeof Saved.Type) =>
      Effect.log("[ServerSync] Commit successful:", {
        playground_hash: saved.playgroundHash,
        commit_id: saved.commitId,
        forked: saved.forked,
        edit_key: Option.isSome(saved.editKey) ? "[redacted]" : null,
      }).pipe(
        Effect.andThen(
          Effect.sync(() =>
            Option.map(saved.editKey, (key) => rememberEditKey(saved.playgroundHash, key)),
          ),
        ),
      );

    /**
     * Gives the author of a playground saved without an account its edit link.
     *
     * Such a playground is held by its key and by nothing else: there is no
     * password to recover and no account to sign in to, so the link is the
     * whole claim to it. Hence the clipboard and the warning.
     */
    const offerEditLink = Effect.fnUntraced(function* (saved: typeof Saved.Type, editKey: string) {
      const path = buildPath({ type: "playground", playgroundHash: saved.playgroundHash });
      const link = editKeyLink(`${window.location.origin}${path}`, editKey);
      const copied = yield* Effect.tryPromise({
        try: () => navigator.clipboard.writeText(link),
        catch: toSaveError,
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
      const where = copied ? "Your edit link is on the clipboard" : `Your edit link is ${link}`;
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
        if (heldEditKey(saved.playgroundHash) === null) return;
        if (yield* claimWithEditKey(saved.playgroundHash)) {
          yield* showInformation(
            "This playground is on your account now, and the edit link no longer opens it.",
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("[ServerSync] Sign-in to keep the playground did not finish:", error),
        ),
      );
    });

    /** Offers a new sign-in after the server refused the session. */
    const offerSignIn = Effect.gen(function* () {
      const choice = yield* showWarning(
        "Your session has expired. Please sign in again to sync.",
        "Sign In",
        "Cancel",
      );
      if (choice !== "Sign In") return;
      yield* signIn({ createIfNone: true, forceNewSession: true }).pipe(
        Effect.andThen(showInformation("Signed in successfully. Please try syncing again.")),
        Effect.catch(() =>
          Effect.sync(
            () =>
              void vscodeApi.window.showErrorMessage("Authentication failed. Please try again."),
          ),
        ),
      );
    });

    /**
     * Tells the author what `outcome` means for their work. It waits while a
     * dialog waits for an answer, so it runs after any progress notification
     * has closed. A stale save is the caller's to resolve: the choice it
     * offers changes what the tab holds.
     */
    const announce = (outcome: typeof Saved.Type | typeof SessionExpired.Type) =>
      Match.valueTags(outcome, {
        SessionExpired: () => offerSignIn,
        Saved: (saved) =>
          saved.forked
            ? showInformation(
                `Playground forked: ${saved.fileCount} file(s) saved. You now own this copy and can continue making commits.`,
              )
            : Option.match(saved.editKey, {
                onNone: () => showInformation(`Workspace synced: ${saved.fileCount} file(s) saved`),
                onSome: (editKey) => offerEditLink(saved, editKey),
              }),
      });

    return { upload, announce };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const toSaveError = (cause: unknown) =>
  new PlaygroundSaveError({ message: toErrorMessage(cause), cause });

/** A unique name for a new playground: workspace_YYYYMMDD_HHMMSS_milliseconds. */
const playgroundName = (now: DateTime.Utc) => {
  const date = DateTime.toDate(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `workspace_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${date.getMilliseconds()}`;
};
