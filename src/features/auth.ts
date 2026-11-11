/**
 * Postgres Garden Authentication Provider for VSCode Workbench
 * Integrates with the built-in accounts menu in the activity bar
 */

import * as vscode from "vscode";
import * as S from "effect/Schema";
import { Effect, Layer, Match, Option } from "effect";
import { ApiCaller } from "../httpapi-client";
import { readInitialData } from "../shared/dehydrate";
import type { SessionUser } from "../../shared/api/auth";
import {
  GITHUB_SIGNIN,
  GITHUB_ACCOUNT_MENU,
  GITHUB_SIGNOUT,
  ACCOUNT_SETTINGS_OPEN,
} from "./constants";
import { AccountSettingsPanelProvider } from "./account/AccountSettingsPanelProvider";
import { AuthPanelProvider } from "./auth-panel/AuthPanelProvider";
import { VSCodeService } from "../vscode/service";
import { Workbench } from "../workbench";

/**
 * What the OAuth popup tells the tab that opened it. It carries no identity:
 * the callback response sets the session cookie, so the signed-in user is read
 * from the server instead of trusted from a message.
 */
const GitHubAuthOutcome = S.Union([
  S.Struct({ type: S.Literals(["github-auth-success"]) }),
  S.Struct({ type: S.Literals(["github-auth-failure"]), message: S.String }),
]);
type GitHubAuthOutcome = typeof GitHubAuthOutcome.Type;

/** Anything that is not an outcome reads as absent, and the sign-in keeps waiting. */
const decodeAuthOutcome = S.decodeUnknownOption(GitHubAuthOutcome);

const AUTH_PROVIDER_ID = "github-auth";

/** The channel name the popup page rendered by the OAuth callback posts on. */
const AUTH_CHANNEL = "github-auth";

/** How long a sign-in may stay unanswered before the popup is given up on. */
const SIGN_IN_TIMEOUT = "5 minutes";

class AuthError extends S.TaggedError<AuthError, { readonly brand: unique symbol }>()("AuthError", {
  message: S.String,
}) {}

/**
 * Authentication session
 */
class AuthSession implements vscode.AuthenticationSession {
  readonly account: { id: string; label: string };
  readonly id = AUTH_PROVIDER_ID;
  readonly scopes = [];

  constructor(
    public readonly accessToken: string,
    public readonly username: string,
  ) {
    this.account = { id: AUTH_PROVIDER_ID, label: username };
  }
}

/**
 * Authentication provider
 * Supports email/password and GitHub OAuth
 * Uses localStorage for persistence and syncs with server via cookies
 */
export class AuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  static id = AUTH_PROVIDER_ID;
  static label = "postgres.garden";
  private static storageKey = "github-username";

  private currentUsername: string | undefined;
  private initializedDisposable: vscode.Disposable | undefined;
  private extensionUri: vscode.Uri | undefined;

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  get onDidChangeSessions(): vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> {
    return this._onDidChangeSessions.event;
  }

  constructor(
    user: Option.Option<typeof SessionUser.Type>,
    /** The caller for server requests, taken when the layer is built. */
    private readonly call: ApiCaller["Service"]["call"],
    /**
     * Runs the sign-in and sign-out flows in the workbench's runtime. VS Code
     * calls into this class from outside the layer graph and expects Promises.
     */
    private readonly run: Workbench["Service"]["runPromise"],
  ) {
    if (Option.isSome(user)) {
      this.currentUsername = user.value.username;
      localStorage.setItem(AuthProvider.storageKey, this.currentUsername);
    } else {
      localStorage.removeItem(AuthProvider.storageKey);
      this.currentUsername = undefined;
    }
  }

  setExtensionUri(uri: vscode.Uri) {
    this.extensionUri = uri;
  }

  dispose(): void {
    this.initializedDisposable?.dispose();
  }

  private ensureInitialized(): void {
    if (this.initializedDisposable === undefined) {
      this.initializedDisposable = vscode.Disposable.from(
        // Listen for auth changes from other windows/tabs
        vscode.authentication.onDidChangeSessions((e) => {
          if (e.provider.id === AuthProvider.id) {
            this.checkForUpdates();
          }
        }),
      );
    }
  }

  private checkForUpdates() {
    const added: vscode.AuthenticationSession[] = [];
    const removed: vscode.AuthenticationSession[] = [];
    const changed: vscode.AuthenticationSession[] = [];

    const previousUsername = this.currentUsername;
    const storedUsername = localStorage.getItem(AuthProvider.storageKey);

    if (storedUsername && !previousUsername) {
      this.currentUsername = storedUsername;
      added.push(new AuthSession(storedUsername, storedUsername));
    } else if (!storedUsername && previousUsername) {
      this.currentUsername = undefined;
      removed.push(new AuthSession(previousUsername, previousUsername));
    } else if (storedUsername !== previousUsername) {
      this.currentUsername = storedUsername || undefined;
      if (storedUsername) {
        changed.push(new AuthSession(storedUsername, storedUsername));
      }
    } else {
      return;
    }

    this._onDidChangeSessions.fire({ added, removed, changed });
  }

  getSessions(): Promise<vscode.AuthenticationSession[]> {
    this.ensureInitialized();
    const username = this.currentUsername || localStorage.getItem(AuthProvider.storageKey);
    return Promise.resolve(username ? [new AuthSession(username, username)] : []);
  }

  createSession(): Promise<vscode.AuthenticationSession> {
    this.ensureInitialized();

    // Open auth panel with login/register/GitHub options
    return this.run(
      Effect.callback<vscode.AuthenticationSession, AuthError>((resume) => {
        if (!this.extensionUri) {
          resume(Effect.fail(new AuthError({ message: "Extension URI not set" })));
          return;
        }

        AuthPanelProvider.createOrShow(this.extensionUri, {
          onAuth: (username: string) => {
            resume(Effect.succeed(this.completeAuth(username)));
          },
          onGitHubSignIn: () => {
            // User clicked GitHub button — run OAuth popup flow
            this.createSessionWithGitHub()
              .then((session) => {
                AuthPanelProvider.notifyGitHubComplete(session.username);
                // Session is already stored by createSessionWithGitHub
                resume(Effect.succeed(session));
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                AuthPanelProvider.notifyGitHubError(msg);
                // Don't reject — let user try again
              });
          },
          onCancel: () => {
            resume(Effect.fail(new AuthError({ message: "Authentication was cancelled" })));
          },
        });
      }),
    );
  }

  /**
   * Records the signed-in user and announces the new session, which is what
   * every path through sign-in ends with: the auth panel's email and password
   * form, the GitHub popup, and the sign-in command that opens the panel on its
   * own.
   */
  completeAuth(username: string): AuthSession {
    localStorage.setItem(AuthProvider.storageKey, username);
    this.currentUsername = username;
    const session = new AuthSession(username, username);
    this._onDidChangeSessions.fire({
      added: [session],
      removed: [],
      changed: [],
    });
    return session;
  }

  removeSession(): Promise<void> {
    return this.run(
      Effect.gen({ self: this }, function* () {
        const username = this.currentUsername;
        if (!username) return;

        localStorage.removeItem(AuthProvider.storageKey);
        this.currentUsername = undefined;
        yield* this.call("auth.logout", (api) => api.auth.logout({})).pipe(
          Effect.catch((error) => Effect.logError("Failed to sync logout with server", error)),
        );
        this._onDidChangeSessions.fire({
          removed: [new AuthSession(username, username)],
          added: [],
          changed: [],
        });
      }),
    );
  }

  /**
   * Create a session through the GitHub OAuth popup.
   *
   * The popup reports its outcome on a BroadcastChannel, which is the only
   * channel that survives the trip. The app sends
   * `Cross-Origin-Opener-Policy: same-origin` so that the workbench is
   * cross-origin isolated, so the hop through github.com moves the popup into
   * another browsing context group: `window.opener` is null in the popup, and
   * the handle held here is disowned. A disowned handle reads `closed === true`
   * while the popup is still open, so nothing here may watch `popup.closed` —
   * doing so reports every sign-in as cancelled a second after it starts.
   */
  createSessionWithGitHub(): Promise<AuthSession> {
    this.ensureInitialized();

    return this.run(
      Effect.callback<AuthSession, AuthError>((resume) => {
        // The browser's own window, not VSCode's window API.
        const popup = globalThis.window.open(
          "/auth/github",
          AUTH_CHANNEL,
          "width=600,height=700,left=100,top=100",
        );

        if (!popup) {
          resume(
            Effect.fail(
              new AuthError({
                message: "Failed to open authentication popup. Please allow popups for this site.",
              }),
            ),
          );
          return;
        }

        const onOutcome = Match.type<GitHubAuthOutcome>().pipe(
          Match.discriminatorsExhaustive("type")({
            "github-auth-success": () => this.sessionFromServer,
            "github-auth-failure": ({ message }) => Effect.fail(new AuthError({ message })),
          }),
        );

        const channel = new BroadcastChannel(AUTH_CHANNEL);
        // Every same-origin tab shares this channel, so a message that is not an
        // outcome belongs to someone else and the sign-in keeps waiting.
        channel.onmessage = (event: MessageEvent) =>
          Option.map(decodeAuthOutcome(event.data), (outcome) => resume(onOutcome(outcome)));

        return Effect.sync(() => channel.close());
      }).pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AuthError({ message: "Sign-in did not finish in time. Please try again." }),
            ),
        }),
      ),
    );
  }

  /**
   * The session the cookie now belongs to, according to the server. A success
   * the server does not agree with is a failure here: the popup reports only
   * that the flow finished, never who finished it.
   */
  private get sessionFromServer() {
    return this.call("apiUsers.me", (api) => api.apiUsers.me({})).pipe(
      Effect.mapError((error) => new AuthError({ message: error.message })),
      Effect.flatMap(({ user }) =>
        Option.match(Option.fromNullishOr(user), {
          onNone: () =>
            Effect.fail(new AuthError({ message: "Signed in, but the server reported no user." })),
          onSome: (signedIn) => Effect.succeed(this.completeAuth(signedIn.username)),
        }),
      ),
    );
  }
}

/**
 * Extended QuickPickItem with a value property for menu actions
 */
interface AccountMenuItem extends vscode.QuickPickItem {
  value: "profile" | "settings" | "signout";
}

export const AuthFeatureLive: Layer.Layer<never, never, ApiCaller | VSCodeService | Workbench> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const vscodeService = yield* VSCodeService;
      const { runFork, runPromise } = yield* Workbench;
      const { user: initialUser } = readInitialData();
      const user = Option.fromNullishOr(initialUser);
      const vscodeApi = vscodeService.api;
      const extensionUri = vscodeService.extensionUri;
      const { call } = yield* ApiCaller;

      const provider = new AuthProvider(user, call, runPromise);
      provider.setExtensionUri(extensionUri);

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscode.authentication.registerAuthenticationProvider(
            AuthProvider.id,
            AuthProvider.label,
            provider,
          ),
        ),
        (disposable) => Effect.sync(() => disposable.dispose()),
      );

      // === Status Bar Integration ===
      const statusBarItem = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const item = vscodeApi.window.createStatusBarItem(
            vscodeApi.StatusBarAlignment.Right,
            100,
          );
          item.show();
          return item;
        }),
        (item) => Effect.sync(() => item.dispose()),
      );

      const updateStatusBar = () =>
        runPromise(
          Effect.gen(function* () {
            // Use provider directly since vscode.authentication.getSession() may not
            // surface sessions from our provider without user interaction
            const sessions = yield* Effect.promise(() => provider.getSessions());
            const session = sessions[0];

            if (session) {
              const username = session.account?.label || "User";
              statusBarItem.text = `$(account) ${username}`;
              statusBarItem.tooltip = `Signed in as ${username}\nClick for account options`;
              statusBarItem.command = GITHUB_ACCOUNT_MENU;
            } else {
              statusBarItem.text = "$(account) Sign In";
              statusBarItem.tooltip = "Click to sign in";
              statusBarItem.command = GITHUB_SIGNIN;
            }
          }),
        );

      // Register sign in command — opens auth panel directly (sync handler)
      yield* vscodeService.registerCommand(GITHUB_SIGNIN, () => {
        AuthPanelProvider.createOrShow(extensionUri, {
          onAuth: (username: string) => {
            localStorage.setItem("github-username", username);
            provider.completeAuth(username);
          },
          onGitHubSignIn: () => {
            provider
              .createSessionWithGitHub()
              .then((session) => {
                AuthPanelProvider.notifyGitHubComplete(session.username);
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                AuthPanelProvider.notifyGitHubError(msg);
              });
          },
          onCancel: () => {
            // User closed the panel — nothing to do
          },
        });
      });

      // Register sign out command — single source of truth for logout
      yield* vscodeService.registerCommand(GITHUB_SIGNOUT, () => {
        runFork(
          Effect.gen(function* () {
            const confirmed = yield* Effect.tryPromise({
              try: () =>
                vscode.window.showWarningMessage(
                  "Are you sure you want to sign out?",
                  { modal: true },
                  "Sign Out",
                ),
              catch: (err) =>
                new AuthError({
                  message: err instanceof Error ? err.message : String(err),
                }),
            });
            if (confirmed !== "Sign Out") return;

            yield* Effect.promise(() => provider.removeSession());
            window.location.reload();
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                void vscode.window.showErrorMessage(
                  `Sign out failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }),
            ),
            Effect.ignore,
          ),
        );
      });

      // Register account settings command (sync handler)
      yield* vscodeService.registerCommand(ACCOUNT_SETTINGS_OPEN, () => {
        AccountSettingsPanelProvider.createOrShow(extensionUri);
      });

      // Register account menu command
      yield* vscodeService.registerCommand(GITHUB_ACCOUNT_MENU, () => {
        runFork(
          Effect.gen(function* () {
            const sessions = yield* Effect.promise(() => provider.getSessions());
            if (sessions.length === 0) return;

            const menuItems: AccountMenuItem[] = [
              { label: "$(account) Account Settings", value: "settings" },
              { label: "$(sign-out) Sign Out", value: "signout" },
            ];

            const selected = yield* Effect.tryPromise({
              try: () =>
                vscode.window.showQuickPick(menuItems, {
                  placeHolder: "Account Options",
                }),
              catch: (err) =>
                new AuthError({
                  message: err instanceof Error ? err.message : String(err),
                }),
            });

            if (!selected) return;

            switch (selected.value) {
              case "settings":
                yield* Effect.promise(() =>
                  vscodeApi.commands.executeCommand(ACCOUNT_SETTINGS_OPEN),
                );
                break;
              case "signout":
                yield* Effect.promise(() => vscodeApi.commands.executeCommand(GITHUB_SIGNOUT));
                break;
            }
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                void vscode.window.showErrorMessage(
                  `Account menu failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }),
            ),
            Effect.ignore,
          ),
        );
      });

      // Listen for authentication changes (scoped event listener)
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === AuthProvider.id) {
              void updateStatusBar();
            }
          }),
        ),
        (disposable) => Effect.sync(() => disposable.dispose()),
      );

      // Initial status bar update
      void updateStatusBar();

      // === Account mail links ===
      // worker/accountMail.ts puts each link's parameters in the fragment, so
      // its token reaches no server log or Referer header.
      const pathname = window.location.pathname;
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));

      if (pathname === "/reset") {
        const token = fragment.get("token");
        if (token) {
          AuthPanelProvider.createOrShow(extensionUri, undefined, "reset-password", { token });
          // Clean URL
          window.history.replaceState({}, "", "/");
        }
      } else if (pathname === "/verify") {
        const token = fragment.get("token");
        if (token) {
          AuthPanelProvider.createOrShow(extensionUri, undefined, "verify-email", { token });
          // Clean URL
          window.history.replaceState({}, "", "/");
        }
      } else if (pathname === "/settings") {
        const deleteToken = fragment.get("token");
        AccountSettingsPanelProvider.createOrShow(extensionUri, {
          section: deleteToken ? "danger-zone" : undefined,
          deleteToken: deleteToken ?? undefined,
        });
        window.history.replaceState({}, "", "/");
      }
    }).pipe(Effect.withSpan("feature.auth")),
  );
