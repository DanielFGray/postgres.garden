/**
 * Postgres Garden Authentication Provider for VSCode Workbench
 * Integrates with the built-in accounts menu in the activity bar
 */

import * as vscode from "vscode";
import * as S from "effect/Schema";
import { Effect, Layer, Option } from "effect";
import { HydrationState } from "fibrae";
import { httpApiLogout } from "../httpapi-client";
import { hydratePageState } from "../shared/dehydrate";
import type { User } from "../shared/schemas";
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

/** Schema for auth messages received via postMessage / localStorage / BroadcastChannel */
const AuthMessage = S.Struct({
  type: S.Literal("github-auth-success"),
  user: S.Struct({ username: S.String }),
});
const isAuthMessage = S.is(AuthMessage);

const AUTH_PROVIDER_ID = "github-auth";

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

  constructor(user: Option.Option<User>) {
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
    return new Promise<vscode.AuthenticationSession>((resolve, reject) => {
      if (!this.extensionUri) {
        reject(new Error("Extension URI not set"));
        return;
      }

      AuthPanelProvider.createOrShow(this.extensionUri, {
        onAuth: (username: string) => {
          // Email/password auth completed — update state
          localStorage.setItem(AuthProvider.storageKey, username);
          this.currentUsername = username;
          const session = new AuthSession(username, username);
          this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
          resolve(session);
        },
        onGitHubSignIn: () => {
          // User clicked GitHub button — run OAuth popup flow
          this.createSessionWithGitHub()
            .then((session) => {
              AuthPanelProvider.notifyGitHubComplete(session.username);
              // Session is already stored by createSessionWithGitHub
              resolve(session);
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              AuthPanelProvider.notifyGitHubError(msg);
              // Don't reject — let user try again
            });
        },
        onCancel: () => {
          reject(new Error("Authentication was cancelled"));
        },
      });
    });
  }

  /**
   * Called when email/password auth completes outside the VSCode auth API flow
   * (e.g., from the sign-in command opening the panel directly).
   */
  completeAuth(username: string) {
    localStorage.setItem(AuthProvider.storageKey, username);
    this.currentUsername = username;
    const session = new AuthSession(username, username);
    this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
  }

  async removeSession(): Promise<void> {
    const username = this.currentUsername;
    if (!username) {
      return;
    }

    // Clear localStorage
    localStorage.removeItem(AuthProvider.storageKey);
    this.currentUsername = undefined;

    // Sync with server to clear session cookie
    try {
      await Effect.runPromise(httpApiLogout);
    } catch (error) {
      console.error("Failed to sync logout with server:", error);
    }

    // Fire session change event
    this._onDidChangeSessions.fire({
      removed: [new AuthSession(username, username)],
      added: [],
      changed: [],
    });
  }

  /**
   * Create session using GitHub OAuth in a popup window
   */
  async createSessionWithGitHub(): Promise<AuthSession> {
    this.ensureInitialized();

    return new Promise((resolve, reject) => {
      // Access the actual browser window (not VSCode's window API)
      const browserWindow = globalThis.window;

      const popup = browserWindow.open(
        "/auth/github?mode=popup",
        "github-auth",
        "width=600,height=700,left=100,top=100",
      );

      if (!popup) {
        reject(
          new Error("Failed to open authentication popup. Please allow popups for this site."),
        );
        return;
      }

      let isResolved = false;
      const storageKey = "github-auth-result";

      const completeAuth = (user: { username: string }) => {
        if (isResolved) return;
        isResolved = true;

        const username = user.username;

        // Store in localStorage
        localStorage.setItem(AuthProvider.storageKey, username);
        this.currentUsername = username;

        // Clean up auth result from localStorage
        localStorage.removeItem(storageKey);

        // Create session
        const session = new AuthSession(username, username);

        // Fire session change event
        this._onDidChangeSessions.fire({
          added: [session],
          removed: [],
          changed: [],
        });

        // Clean up listeners
        browserWindow.removeEventListener("message", messageHandler);
        browserWindow.removeEventListener("storage", storageHandler);
        if (broadcastChannel) {
          broadcastChannel.close();
        }
        clearInterval(checkPopup);
        clearInterval(pollStorage);

        resolve(session);
      };

      // Method 1: Listen for postMessage (may not work due to redirects)
      const messageHandler = (event: MessageEvent) => {
        // Verify origin for security
        if (event.origin !== browserWindow.location.origin) {
          return;
        }
        if (isAuthMessage(event.data)) {
          completeAuth(event.data.user);
        }
      };
      browserWindow.addEventListener("message", messageHandler);

      // Method 2: Listen for storage events
      const storageHandler = (event: StorageEvent) => {
        if (event.key === "github-auth-trigger" || event.key === storageKey) {
          const result = localStorage.getItem(storageKey);
          if (result) {
            try {
              const data: unknown = JSON.parse(result);
              if (isAuthMessage(data)) {
                completeAuth(data.user);
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      };
      browserWindow.addEventListener("storage", storageHandler);

      // Method 3: Use BroadcastChannel if available
      let broadcastChannel: BroadcastChannel | null = null;
      if (typeof BroadcastChannel !== "undefined") {
        broadcastChannel = new BroadcastChannel("github-auth");
        broadcastChannel.onmessage = (event: MessageEvent) => {
          if (isAuthMessage(event.data)) {
            completeAuth(event.data.user);
          }
        };
      }

      // Method 4: Poll localStorage as fallback (in case storage event doesn't fire)
      const pollStorage = setInterval(() => {
        const result = localStorage.getItem(storageKey);
        if (result) {
          try {
            const data: unknown = JSON.parse(result);
            if (isAuthMessage(data)) {
              completeAuth(data.user);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }, 500);

      // Check if popup was closed without completing auth
      const checkPopup = setInterval(() => {
        if (popup.closed) {
          if (!isResolved) {
            // Give one final check for the result
            const result = localStorage.getItem(storageKey);
            if (result) {
              try {
                const data: unknown = JSON.parse(result);
                if (isAuthMessage(data)) {
                  completeAuth(data.user);
                  return;
                }
              } catch {
                // Ignore
              }
            }

            clearInterval(checkPopup);
            clearInterval(pollStorage);
            browserWindow.removeEventListener("message", messageHandler);
            browserWindow.removeEventListener("storage", storageHandler);
            if (broadcastChannel) {
              broadcastChannel.close();
            }
            reject(new Error("Authentication was cancelled"));
          }
        }
      }, 1000);
    });
  }
}

// Export provider instance for use in other modules
export let authProviderInstance: AuthProvider | undefined;

/**
 * Extended QuickPickItem with a value property for menu actions
 */
interface AccountMenuItem extends vscode.QuickPickItem {
  value: "profile" | "settings" | "signout";
}

export const AuthFeatureLive: Layer.Layer<never, never, VSCodeService | HydrationState | Workbench> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const vscodeService = yield* VSCodeService;
      const { runFork } = yield* Workbench;
      const { user: initialUser } = hydratePageState(yield* HydrationState);
      const user = Option.fromNullable(initialUser);
      const vscodeApi = vscodeService.api;
      const extensionUri = vscodeService.extensionUri;

      // Register the authentication provider
      const provider = new AuthProvider(user);
      authProviderInstance = provider;
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

      // Update status bar based on current auth state
      // Kept as plain async closure — fire-and-forget via void updateStatusBar()
      const updateStatusBar = async () => {
        // Use provider directly since vscode.authentication.getSession() may not
        // surface sessions from our provider without user interaction
        const sessions = await provider.getSessions();
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
      };

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
              .catch((err: unknown) => {
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
              catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
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
            Effect.catchAll(() => Effect.void),
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
                vscode.window.showQuickPick(menuItems, { placeHolder: "Account Options" }),
              catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
            });

            if (!selected) return;

            switch (selected.value) {
              case "settings":
                yield* Effect.promise(() =>
                  vscodeApi.commands.executeCommand(ACCOUNT_SETTINGS_OPEN),
                );
                break;
              case "signout":
                yield* Effect.promise(() =>
                  vscodeApi.commands.executeCommand(GITHUB_SIGNOUT),
                );
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
            Effect.catchAll(() => Effect.void),
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

      // === URL Parameter Detection ===
      // Check for /verify and /reset URLs from email links
      const url = new URL(window.location.href);
      const pathname = url.pathname;

      if (pathname === "/reset") {
        const userId = url.searchParams.get("userId");
        const token = url.searchParams.get("token");
        if (userId && token) {
          AuthPanelProvider.createOrShow(extensionUri, undefined, "reset-password", {
            userId,
            token,
          });
          // Clean URL
          window.history.replaceState({}, "", "/");
        }
      } else if (pathname === "/verify") {
        const emailId = url.searchParams.get("id");
        const token = url.searchParams.get("token");
        if (emailId && token) {
          AuthPanelProvider.createOrShow(extensionUri, undefined, "verify-email", {
            emailId,
            token,
          });
          // Clean URL
          window.history.replaceState({}, "", "/");
        }
      }
    }).pipe(Effect.withSpan("feature.auth")),
  );
