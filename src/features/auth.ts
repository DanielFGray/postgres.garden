/**
 * Postgres Garden Authentication Provider for VSCode Workbench
 * Integrates with the built-in accounts menu in the activity bar
 */

import * as vscode from "vscode";
import {
  registerExtension,
  ExtensionHostKind,
} from "@codingame/monaco-vscode-api/extensions";
import * as S from "effect/Schema";
import { api } from "../api-client";
import {
  GITHUB_SIGNIN,
  GITHUB_ACCOUNT_MENU,
  GITHUB_SIGNOUT,
  ACCOUNT_SETTINGS_OPEN,
} from "./constants";
import { AccountSettingsPanelProvider } from "./account/AccountSettingsPanelProvider";

/** Schema for auth messages received via postMessage / localStorage / BroadcastChannel */
const AuthMessage = S.Struct({
  type: S.Literal("github-auth-success"),
  user: S.Struct({ username: S.String }),
});
const isAuthMessage = S.is(AuthMessage);

const GITHUB_AUTH_ID = "github-auth";

/**
 * GitHub authentication session
 */
class GitHubAuthSession implements vscode.AuthenticationSession {
  readonly account: { id: string; label: string };
  readonly id = GITHUB_AUTH_ID;
  readonly scopes = [];

  constructor(
    public readonly accessToken: string,
    public readonly username: string,
  ) {
    this.account = { id: GITHUB_AUTH_ID, label: username };
  }
}

/**
 * GitHub authentication provider
 * Uses localStorage for persistence and syncs with server via cookies
 */
export class GitHubAuthProvider
  implements vscode.AuthenticationProvider, vscode.Disposable {
  static id = GITHUB_AUTH_ID;
  static label = "GitHub";
  private static storageKey = "github-username";

  private currentUsername: string | undefined;
  private initializedDisposable: vscode.Disposable | undefined;

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  get onDidChangeSessions(): vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> {
    return this._onDidChangeSessions.event;
  }

  constructor() {
    // Initialize with username from SSR data if available
    // Always trust the server session (__INITIAL_DATA__) as the source of truth
    const initialData = window.__INITIAL_DATA__;
    if (initialData?.user?.username) {
      this.currentUsername = initialData.user.username;
      // Store in localStorage for persistence
      localStorage.setItem(GitHubAuthProvider.storageKey, this.currentUsername);
    } else {
      // No server session - clear any stale localStorage
      localStorage.removeItem(GitHubAuthProvider.storageKey);
      this.currentUsername = undefined;
    }
  }

  dispose(): void {
    this.initializedDisposable?.dispose();
  }

  private ensureInitialized(): void {
    if (this.initializedDisposable === undefined) {
      this.initializedDisposable = vscode.Disposable.from(
        // Listen for auth changes from other windows/tabs
        vscode.authentication.onDidChangeSessions((e) => {
          if (e.provider.id === GitHubAuthProvider.id) {
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
    const storedUsername = localStorage.getItem(GitHubAuthProvider.storageKey);

    if (storedUsername && !previousUsername) {
      this.currentUsername = storedUsername;
      added.push(new GitHubAuthSession(storedUsername, storedUsername));
    } else if (!storedUsername && previousUsername) {
      this.currentUsername = undefined;
      removed.push(new GitHubAuthSession(previousUsername, previousUsername));
    } else if (storedUsername !== previousUsername) {
      this.currentUsername = storedUsername || undefined;
      if (storedUsername) {
        changed.push(new GitHubAuthSession(storedUsername, storedUsername));
      }
    } else {
      return;
    }

    this._onDidChangeSessions.fire({ added, removed, changed });
  }

  getSessions(): Promise<vscode.AuthenticationSession[]> {
    this.ensureInitialized();
    const username =
      this.currentUsername ||
      localStorage.getItem(GitHubAuthProvider.storageKey);
    return Promise.resolve(username ? [new GitHubAuthSession(username, username)] : []);
  }

  createSession() {
    this.ensureInitialized();

    // Use GitHub OAuth via the createSessionWithGitHub method
    return this.createSessionWithGitHub();
  }

  async removeSession(): Promise<void> {
    const username = this.currentUsername;
    if (!username) {
      return;
    }

    // Clear localStorage
    localStorage.removeItem(GitHubAuthProvider.storageKey);
    this.currentUsername = undefined;

    // Sync with server to clear session cookie
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      console.error("Failed to sync logout with server:", error);
    }

    // Fire session change event
    this._onDidChangeSessions.fire({
      removed: [new GitHubAuthSession(username, username)],
      added: [],
      changed: [],
    });
  }

  /**
   * Create session using GitHub OAuth in a popup window
   */
  async createSessionWithGitHub(): Promise<vscode.AuthenticationSession> {
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
          new Error(
            "Failed to open authentication popup. Please allow popups for this site.",
          ),
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
        localStorage.setItem(GitHubAuthProvider.storageKey, username);
        this.currentUsername = username;

        // Clean up auth result from localStorage
        localStorage.removeItem(storageKey);

        // Create session
        const session = new GitHubAuthSession(username, username);

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
export let authProviderInstance: GitHubAuthProvider | undefined;

const ext = registerExtension(
  {
    name: "postgres.garden",
    publisher: "postgres.garden",
    description: "postgres.garden",
    version: "1.0.0",
    engines: {
      vscode: "*",
    },
  },
  ExtensionHostKind.LocalProcess,
);

/**
 * Extended QuickPickItem with a value property for menu actions
 */
interface AccountMenuItem extends vscode.QuickPickItem {
  value: "profile" | "settings" | "signout";
}

void ext.getApi().then((vsapi) => {
  // Register the authentication provider
  const provider = new GitHubAuthProvider();
  authProviderInstance = provider;

  vscode.authentication.registerAuthenticationProvider(
    GitHubAuthProvider.id,
    GitHubAuthProvider.label,
    provider,
  );

  // === Status Bar Integration ===
  // Create status bar item (now that provider is registered)
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.show();

  // Update status bar based on current auth state
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

  // Register sign in command
  vsapi.commands.registerCommand(GITHUB_SIGNIN, async () => {
    try {
      await vscode.authentication.getSession(GitHubAuthProvider.id, [], {
        createIfNone: true,
      });
      void vscode.window.showInformationMessage("Successfully signed in!");
    } catch (error) {
      void vscode.window.showErrorMessage(`Sign in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Register sign out command — single source of truth for logout
  vsapi.commands.registerCommand(GITHUB_SIGNOUT, async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "Are you sure you want to sign out?",
      { modal: true },
      "Sign Out",
    );
    if (confirmed !== "Sign Out") return;

    await provider.removeSession();
    window.location.reload();
  });

  // Register account settings command
  const extensionUri = vscode.Uri.parse(window.location.origin);
  vsapi.commands.registerCommand(ACCOUNT_SETTINGS_OPEN, () => {
    AccountSettingsPanelProvider.createOrShow(extensionUri);
  });

  // Register account menu command
  vsapi.commands.registerCommand(GITHUB_ACCOUNT_MENU, async () => {
    try {
      const sessions = await vscode.authentication.getSession(
        GitHubAuthProvider.id,
        [],
        { createIfNone: false },
      );
      if (!sessions) return;

      const menuItems: AccountMenuItem[] = [
        { label: "$(account) Account Settings", value: "settings" },
        { label: "$(sign-out) Sign Out", value: "signout" },
      ];

      const selected = await vscode.window.showQuickPick(menuItems, {
        placeHolder: "Account Options",
      });

      if (!selected) return;

      switch (selected.value) {
        case "settings":
          await vsapi.commands.executeCommand(ACCOUNT_SETTINGS_OPEN);
          break;
        case "signout":
          await vsapi.commands.executeCommand(GITHUB_SIGNOUT);
          break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Account menu failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Listen for authentication changes
  vscode.authentication.onDidChangeSessions((e) => {
    if (e.provider.id === GitHubAuthProvider.id) {
      void updateStatusBar();
    }
  });

  // Initial status bar update
  void updateStatusBar();
});
